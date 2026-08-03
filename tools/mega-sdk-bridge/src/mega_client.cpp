#include "mega_client.hpp"

#include <megaapi.h>
#include <mega/version.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

#include <array>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <memory>
#include <regex>
#include <sstream>
#include <unordered_set>
#include <utility>

#ifndef _WIN32
#include <fcntl.h>
#include <unistd.h>
#endif

namespace omnia::mega_bridge
{
namespace
{

static_assert(
    MEGA_MAJOR_VERSION == 10 && MEGA_MINOR_VERSION == 17 &&
        MEGA_MICRO_VERSION == 0,
    "The MEGA bridge must be reviewed before upgrading the official SDK");

constexpr std::size_t maximumEnumeratedNodes = 20'000;
constexpr int transferTimeoutMilliseconds = 2 * 60 * 60 * 1000;

using MegaNodePtr = std::unique_ptr<mega::MegaNode>;
using MegaNodeListPtr = std::unique_ptr<mega::MegaNodeList>;
using MegaCancelTokenPtr = std::unique_ptr<mega::MegaCancelToken>;
using MegaUploadOptionsPtr = std::unique_ptr<mega::MegaUploadOptions>;
using CharacterArrayPtr = std::unique_ptr<char[]>;

[[nodiscard]] std::string randomIdentifier()
{
    std::array<unsigned char, 18> bytes{};
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1)
    {
        throw BridgeError{
            500,
            "CRYPTOGRAPHY",
            "Secure random generation failed"};
    }
    std::ostringstream value;
    value << std::hex << std::setfill('0');
    for (const auto byte: bytes)
    {
        value << std::setw(2) << static_cast<unsigned>(byte);
    }
    return value.str();
}

[[nodiscard]] std::string copyString(const char* value)
{
    return value == nullptr ? std::string{} : std::string{value};
}

[[nodiscard]] std::string nodeHandle(mega::MegaNode& node)
{
    CharacterArrayPtr encoded{node.getBase64Handle()};
    if (!encoded)
    {
        throw BridgeError{502, "MEGA_SDK_ERROR", "MEGA returned an invalid node"};
    }
    return encoded.get();
}

[[nodiscard]] std::string nodePath(mega::MegaApi& api, mega::MegaNode& node)
{
    CharacterArrayPtr path{api.getNodePath(&node)};
    return path ? std::string{path.get()} : std::string{"/"};
}

enum class TransferKind
{
    upload,
    download
};

[[noreturn]] void throwMegaError(
    int errorCode,
    std::optional<TransferKind> transferKind = std::nullopt)
{
    switch (errorCode)
    {
        case mega::MegaError::API_ESID:
            throw BridgeError{
                401,
                "SESSION_EXPIRED",
                "The MEGA session has expired"};
        case mega::MegaError::API_EMFAREQUIRED:
            throw BridgeError{
                401,
                "MFA_REQUIRED",
                "MEGA multi-factor authentication is required"};
        case mega::MegaError::API_EOVERQUOTA:
            if (transferKind == TransferKind::download)
            {
                throw BridgeError{
                    429,
                    "TRANSFER_QUOTA",
                    "The MEGA transfer quota is temporarily exhausted"};
            }
            [[fallthrough]];
        case mega::MegaError::API_EGOINGOVERQUOTA:
        case mega::MegaError::API_EPAYWALL:
            throw BridgeError{
                507,
                "STORAGE_QUOTA",
                "The MEGA storage quota is exhausted"};
        case mega::MegaError::API_ENOENT:
            throw BridgeError{404, "NOT_FOUND", "The MEGA node was not found"};
        case mega::MegaError::API_EACCESS:
        case mega::MegaError::API_EMASTERONLY:
        case mega::MegaError::API_EBUSINESSPASTDUE:
            throw BridgeError{
                403,
                "ACCESS_DENIED",
                "MEGA denied access to the requested node"};
        case mega::MegaError::API_EEXIST:
            throw BridgeError{
                409,
                "DUPLICATE_NODES",
                "The MEGA destination already exists"};
        default:
            throw BridgeError{
                502,
                "MEGA_SDK_ERROR",
                "The MEGA SDK operation failed"};
    }
}

void checkMegaError(
    const mega::MegaError* error,
    std::optional<TransferKind> transferKind = std::nullopt)
{
    if (error == nullptr)
    {
        throw BridgeError{
            502,
            "MEGA_SDK_ERROR",
            "The MEGA SDK returned no result"};
    }
    if (error->getErrorCode() != mega::MegaError::API_OK)
    {
        throwMegaError(error->getErrorCode(), transferKind);
    }
}

template<typename Starter>
mega::MegaRequest* waitForRequest(Starter&& starter)
{
    mega::SynchronousRequestListener listener;
    std::forward<Starter>(starter)(&listener);
    listener.wait();
    checkMegaError(listener.getError());
    auto* request = listener.getRequest();
    if (request == nullptr)
    {
        throw BridgeError{
            502,
            "MEGA_SDK_ERROR",
            "The MEGA SDK returned no request"};
    }
    return request->copy();
}

template<typename Starter>
std::unique_ptr<mega::MegaTransfer> waitForTransfer(
    TransferKind kind,
    mega::MegaCancelToken& cancelToken,
    const CancellationRequested& cancellationRequested,
    Starter&& starter)
{
    mega::SynchronousTransferListener listener;
    std::forward<Starter>(starter)(&listener);
    constexpr auto pollingInterval = std::chrono::milliseconds{250};
    const auto deadline =
        std::chrono::steady_clock::now() +
        std::chrono::milliseconds{transferTimeoutMilliseconds};
    while (listener.trywait(
               static_cast<int>(pollingInterval.count())) != 0)
    {
        if (cancellationRequested && cancellationRequested())
        {
            cancelToken.cancel();
            listener.wait();
            throw BridgeError{
                499,
                "TRANSFER_CANCELLED",
                "The MEGA transfer was cancelled"};
        }
        if (std::chrono::steady_clock::now() >= deadline)
        {
            cancelToken.cancel();
            listener.wait();
            throw BridgeError{
                504,
                "TRANSFER_TIMEOUT",
                "The MEGA transfer timed out"};
        }
    }
    checkMegaError(listener.getError(), kind);
    auto* transfer = listener.getTransfer();
    if (transfer == nullptr)
    {
        throw BridgeError{
            502,
            "MEGA_SDK_ERROR",
            "The MEGA SDK returned no transfer"};
    }
    return std::unique_ptr<mega::MegaTransfer>{transfer->copy()};
}

class ApiSession final
{
public:
    ApiSession(
        const ServiceConfiguration& configuration,
        std::optional<std::string_view> session):
        mCacheDirectory{
            configuration.temporaryDirectory / ("sdk-" + randomIdentifier())}
    {
        std::filesystem::create_directories(mCacheDirectory);
        std::filesystem::permissions(
            mCacheDirectory,
            std::filesystem::perms::owner_all,
            std::filesystem::perm_options::replace);
        mApi = std::make_unique<mega::MegaApi>(
            configuration.appKey.c_str(),
            mCacheDirectory.string().c_str(),
            "Omnia Reader MEGA bridge/0.1",
            2);
        if (session)
        {
            const std::string sessionValue{*session};
            std::unique_ptr<mega::MegaRequest> login{waitForRequest(
                [&](auto* listener) {
                    mApi->fastLogin(sessionValue.c_str(), listener);
                })};
            std::unique_ptr<mega::MegaRequest> fetch{waitForRequest(
                [&](auto* listener) { mApi->fetchNodes(listener); })};
        }
    }

    ~ApiSession()
    {
        mApi.reset();
        std::error_code error;
        std::filesystem::remove_all(mCacheDirectory, error);
    }

    ApiSession(const ApiSession&) = delete;
    ApiSession& operator=(const ApiSession&) = delete;

    [[nodiscard]] mega::MegaApi& api() const
    {
        return *mApi;
    }

private:
    std::filesystem::path mCacheDirectory;
    std::unique_ptr<mega::MegaApi> mApi;
};

[[nodiscard]] MegaNodePtr requireNode(
    mega::MegaApi& api,
    std::string_view encodedHandle)
{
    if (encodedHandle.empty() || encodedHandle.size() > 128)
    {
        throw BridgeError{400, "INVALID_HANDLE", "Invalid MEGA node handle"};
    }
    const std::string handleValue{encodedHandle};
    const auto handle = mega::MegaApi::base64ToHandle(handleValue.c_str());
    if (handle == mega::INVALID_HANDLE)
    {
        throw BridgeError{400, "INVALID_HANDLE", "Invalid MEGA node handle"};
    }
    MegaNodePtr node{api.getNodeByHandle(handle)};
    if (!node)
    {
        throw BridgeError{404, "NOT_FOUND", "The MEGA node was not found"};
    }
    return node;
}

[[nodiscard]] MegaNodePtr requireWritableRoot(
    mega::MegaApi& api,
    std::string_view rootHandle)
{
    auto root = requireNode(api, rootHandle);
    if (root->getType() != mega::MegaNode::TYPE_FOLDER &&
        root->getType() != mega::MegaNode::TYPE_ROOT)
    {
        throw BridgeError{
            400,
            "INVALID_ROOT",
            "The selected MEGA root is not a folder"};
    }
    if (api.getAccess(root.get()) < mega::MegaShare::ACCESS_READWRITE)
    {
        throw BridgeError{
            403,
            "ACCESS_DENIED",
            "The selected MEGA root is not writable"};
    }
    return root;
}

void requireDescendant(
    mega::MegaApi& api,
    mega::MegaNode& root,
    mega::MegaNode& node)
{
    auto current = node.getHandle();
    const auto expected = root.getHandle();
    std::size_t depth = 0;
    while (current != mega::INVALID_HANDLE && depth++ < maximumEnumeratedNodes)
    {
        if (current == expected)
        {
            return;
        }
        MegaNodePtr currentNode{api.getNodeByHandle(current)};
        if (!currentNode)
        {
            break;
        }
        current = currentNode->getParentHandle();
    }
    throw BridgeError{
        403,
        "OUTSIDE_ROOT",
        "The MEGA node is outside the selected root"};
}

[[nodiscard]] MegaNodePtr uniqueFolderChild(
    mega::MegaApi& api,
    mega::MegaNode& parent,
    std::string_view name)
{
    MegaNodeListPtr children{api.getChildren(&parent)};
    MegaNodePtr match;
    if (!children)
    {
        return match;
    }
    for (int index = 0; index < children->size(); ++index)
    {
        auto* child = children->get(index);
        if (child == nullptr || copyString(child->getName()) != name)
        {
            continue;
        }
        if (child->getType() != mega::MegaNode::TYPE_FOLDER || match)
        {
            throw BridgeError{
                409,
                "DUPLICATE_NODES",
                "The MEGA folder path is ambiguous"};
        }
        match.reset(child->copy());
    }
    return match;
}

[[nodiscard]] MegaNodePtr resolveFolder(
    mega::MegaApi& api,
    mega::MegaNode& root,
    const std::vector<std::string>& segments,
    std::size_t count,
    bool create)
{
    MegaNodePtr current{root.copy()};
    for (std::size_t index = 0; index < count; ++index)
    {
        static_cast<void>(sanitizedLeafName(segments[index]));
        auto child = uniqueFolderChild(api, *current, segments[index]);
        if (!child && !create)
        {
            return {};
        }
        if (!child)
        {
            mega::SynchronousRequestListener listener;
            api.createFolder(
                segments[index].c_str(),
                current.get(),
                &listener);
            listener.wait();
            const auto* error = listener.getError();
            if (error != nullptr &&
                error->getErrorCode() == mega::MegaError::API_EEXIST)
            {
                child =
                    uniqueFolderChild(api, *current, segments[index]);
            }
            else
            {
                checkMegaError(error);
                const auto* request = listener.getRequest();
                if (request != nullptr)
                {
                    child.reset(
                        api.getNodeByHandle(request->getNodeHandle()));
                }
            }
            if (!child)
            {
                throw BridgeError{
                    502,
                    "MEGA_SDK_ERROR",
                    "MEGA did not return the created folder"};
            }
        }
        current = std::move(child);
    }
    return current;
}

void requireVacantName(
    mega::MegaApi& api,
    mega::MegaNode& parent,
    std::string_view name,
    mega::MegaHandle permittedHandle = mega::INVALID_HANDLE)
{
    MegaNodeListPtr children{api.getChildren(&parent)};
    if (!children)
    {
        return;
    }
    for (int index = 0; index < children->size(); ++index)
    {
        auto* child = children->get(index);
        if (child != nullptr && copyString(child->getName()) == name &&
            child->getHandle() != permittedHandle)
        {
            throw BridgeError{
                409,
                "DUPLICATE_NODES",
                "The MEGA destination already exists"};
        }
    }
}

[[nodiscard]] File fileFromNode(
    mega::MegaNode& node,
    std::string path)
{
    if (node.getType() != mega::MegaNode::TYPE_FILE || node.getSize() < 0)
    {
        throw BridgeError{400, "INVALID_FILE", "The MEGA node is not a file"};
    }
    const auto handle = nodeHandle(node);
    const auto fingerprint = copyString(node.getFingerprint());
    const auto revision =
        fingerprint.empty() ? handle : handle + ":" + fingerprint;
    const auto* hash = node.getCustomAttr("osh");
    std::optional<std::string> sha256;
    if (hash != nullptr && std::regex_match(hash, std::regex{"[a-f0-9]{64}"}))
    {
        sha256 = hash;
    }
    return {
        handle,
        std::move(path),
        revision,
        static_cast<std::uint64_t>(node.getSize()),
        std::move(sha256)};
}

void enumerateFiles(
    mega::MegaApi& api,
    mega::MegaNode& parent,
    const std::string& parentPath,
    std::string_view prefix,
    std::vector<File>& result,
    std::size_t& visited)
{
    MegaNodeListPtr children{api.getChildren(&parent)};
    if (!children)
    {
        return;
    }
    for (int index = 0; index < children->size(); ++index)
    {
        if (++visited > maximumEnumeratedNodes)
        {
            throw BridgeError{
                413,
                "TOO_MANY_NODES",
                "The MEGA synchronization tree is too large"};
        }
        auto* child = children->get(index);
        if (child == nullptr)
        {
            continue;
        }
        const auto name = copyString(child->getName());
        try
        {
            static_cast<void>(sanitizedLeafName(name));
        }
        catch (const BridgeError&)
        {
            continue;
        }
        const auto path = parentPath + "/" + name;
        if (child->getType() == mega::MegaNode::TYPE_FOLDER)
        {
            enumerateFiles(api, *child, path, prefix, result, visited);
        }
        else if (
            child->getType() == mega::MegaNode::TYPE_FILE &&
            (path == prefix ||
             (path.size() > prefix.size() &&
              path.starts_with(prefix) &&
              path[prefix.size()] == '/')))
        {
            result.push_back(fileFromNode(*child, path));
        }
    }
}

void enumerateFolders(
    mega::MegaApi& api,
    mega::MegaNode& parent,
    std::vector<Folder>& result,
    std::unordered_set<mega::MegaHandle>& visited)
{
    if (!visited.insert(parent.getHandle()).second)
    {
        return;
    }
    if (visited.size() > maximumEnumeratedNodes)
    {
        throw BridgeError{
            413,
            "TOO_MANY_NODES",
            "The MEGA folder set is too large"};
    }
    result.push_back(
        {nodeHandle(parent),
         copyString(parent.getName()).empty()
             ? std::string{"Cloud Drive"}
             : copyString(parent.getName()),
         nodePath(api, parent),
         api.getAccess(&parent) >= mega::MegaShare::ACCESS_READWRITE});

    MegaNodeListPtr children{api.getChildren(&parent)};
    if (!children)
    {
        return;
    }
    for (int index = 0; index < children->size(); ++index)
    {
        auto* child = children->get(index);
        if (child != nullptr &&
            child->getType() == mega::MegaNode::TYPE_FOLDER)
        {
            enumerateFolders(api, *child, result, visited);
        }
    }
}

} // namespace

MegaClient::MegaClient(ServiceConfiguration configuration):
    mConfiguration{std::move(configuration)}
{
    prepareTemporaryDirectory(mConfiguration.temporaryDirectory);
}

LoginResult MegaClient::login(
    std::string_view email,
    const std::string& password,
    const std::optional<std::string>& multiFactorCode) const
{
    ApiSession session{mConfiguration, std::nullopt};
    const std::string emailValue{email};
    mega::SynchronousRequestListener loginListener;
    if (multiFactorCode)
    {
        session.api().multiFactorAuthLogin(
            emailValue.c_str(),
            password.c_str(),
            multiFactorCode->c_str(),
            &loginListener);
    }
    else
    {
        session.api().login(
            emailValue.c_str(),
            password.c_str(),
            &loginListener);
    }
    loginListener.wait();
    const auto* loginError = loginListener.getError();
    if (loginError == nullptr)
    {
        throw BridgeError{
            502,
            "MEGA_SDK_ERROR",
            "The MEGA SDK returned no login result"};
    }
    if (loginError->getErrorCode() == mega::MegaError::API_ENOENT)
    {
        throw BridgeError{
            401,
            "INVALID_CREDENTIALS",
            "MEGA authentication was not accepted"};
    }
    if (multiFactorCode &&
        loginError->getErrorCode() == mega::MegaError::API_EACCESS)
    {
        throw BridgeError{
            401,
            "INVALID_MFA",
            "MEGA multi-factor authentication was not accepted"};
    }
    checkMegaError(loginError);
    std::unique_ptr<mega::MegaRequest> fetch{waitForRequest(
        [&](auto* listener) { session.api().fetchNodes(listener); })};

    CharacterArrayPtr dumped{session.api().dumpSession()};
    CharacterArrayPtr account{session.api().getMyEmail()};
    if (!dumped || !account)
    {
        throw BridgeError{
            502,
            "MEGA_SDK_ERROR",
            "MEGA did not return an authenticated session"};
    }
    return {account.get(), dumped.get()};
}

void MegaClient::logout(std::string_view sessionValue) const
{
    ApiSession session{mConfiguration, sessionValue};
    std::unique_ptr<mega::MegaRequest> request{waitForRequest(
        [&](auto* listener) { session.api().logout(listener); })};
}

std::vector<Folder> MegaClient::folders(std::string_view sessionValue) const
{
    ApiSession session{mConfiguration, sessionValue};
    std::vector<Folder> result;
    std::unordered_set<mega::MegaHandle> visited;
    MegaNodePtr root{session.api().getRootNode()};
    if (root)
    {
        enumerateFolders(session.api(), *root, result, visited);
    }
    MegaNodeListPtr shares{session.api().getInShares()};
    if (shares)
    {
        for (int index = 0; index < shares->size(); ++index)
        {
            auto* share = shares->get(index);
            if (share != nullptr)
            {
                enumerateFolders(session.api(), *share, result, visited);
            }
        }
    }
    return result;
}

std::vector<File> MegaClient::files(
    std::string_view sessionValue,
    std::string_view rootHandle,
    std::string_view prefix) const
{
    const auto logicalPrefix = parseLogicalPath(prefix);
    ApiSession session{mConfiguration, sessionValue};
    auto root = requireWritableRoot(session.api(), rootHandle);
    auto synchronizationRoot = resolveFolder(
        session.api(),
        *root,
        logicalPrefix.segments,
        2,
        false);
    if (!synchronizationRoot)
    {
        return {};
    }

    std::vector<File> result;
    std::size_t visited = 0;
    enumerateFiles(
        session.api(),
        *synchronizationRoot,
        std::string{logical_root},
        logicalPrefix.value,
        result,
        visited);
    return result;
}

Download MegaClient::downloadFile(
    std::string_view sessionValue,
    std::string_view rootHandle,
    std::string_view handle,
    CancellationRequested cancellationRequested) const
{
    ApiSession session{mConfiguration, sessionValue};
    auto root = requireWritableRoot(session.api(), rootHandle);
    auto node = requireNode(session.api(), handle);
    requireDescendant(session.api(), *root, *node);
    if (node->getType() != mega::MegaNode::TYPE_FILE || node->getSize() < 0)
    {
        throw BridgeError{400, "INVALID_FILE", "The MEGA node is not a file"};
    }
    if (static_cast<std::uint64_t>(node->getSize()) >
        mConfiguration.maximumPublicationBytes)
    {
        throw BridgeError{
            413,
            "PUBLICATION_TOO_LARGE",
            "The MEGA file exceeds the configured transfer limit"};
    }

    const auto directory =
        mConfiguration.temporaryDirectory / ("download-" + randomIdentifier());
    std::filesystem::create_directory(directory);
    std::filesystem::permissions(
        directory,
        std::filesystem::perms::owner_all,
        std::filesystem::perm_options::replace);
    const auto destination = directory / "content";
    auto cancelToken =
        MegaCancelTokenPtr{mega::MegaCancelToken::createInstance()};
    try
    {
        const auto destinationValue = destination.string();
        auto transfer = waitForTransfer(
            TransferKind::download,
            *cancelToken,
            cancellationRequested,
            [&](auto* listener) {
                session.api().startDownload(
                    node.get(),
                    destinationValue.c_str(),
                    nullptr,
                    nullptr,
                    true,
                    cancelToken.get(),
                    mega::MegaTransfer::COLLISION_CHECK_ALWAYSERROR,
                    mega::MegaTransfer::COLLISION_RESOLUTION_OVERWRITE,
                    false,
                    listener);
            });
        const auto actualSize = std::filesystem::file_size(destination);
        if (actualSize != static_cast<std::uint64_t>(node->getSize()))
        {
            throw BridgeError{
                502,
                "INTEGRITY",
                "The MEGA download size did not match its metadata"};
        }
        const auto* expectedHash = node->getCustomAttr("osh");
        if (expectedHash != nullptr &&
            std::regex_match(expectedHash, std::regex{"[a-f0-9]{64}"}) &&
            sha256File(destination) != expectedHash)
        {
            throw BridgeError{
                502,
                "INTEGRITY",
                "The MEGA download digest did not match its metadata"};
        }
        std::filesystem::permissions(
            destination,
            std::filesystem::perms::owner_read |
                std::filesystem::perms::owner_write,
            std::filesystem::perm_options::replace);
        return {destination, actualSize};
    }
    catch (...)
    {
        std::error_code error;
        std::filesystem::remove_all(directory, error);
        throw;
    }
}

File MegaClient::uploadFile(
    std::string_view sessionValue,
    std::string_view rootHandle,
    std::string_view path,
    const std::filesystem::path& localPath,
    std::uint64_t expectedSize,
    std::string_view expectedSha256,
    CancellationRequested cancellationRequested) const
{
    const auto logicalPath = parseLogicalPath(path);
    if (logicalPath.segments.size() < 3 ||
        expectedSha256.size() != 64 ||
        !std::regex_match(
            expectedSha256.begin(),
            expectedSha256.end(),
            std::regex{"[a-f0-9]{64}"}))
    {
        throw BridgeError{400, "INTEGRITY", "Invalid upload integrity metadata"};
    }
    if (!isPathWithin(mConfiguration.temporaryDirectory, localPath) ||
        std::filesystem::file_size(localPath) != expectedSize ||
        sha256File(localPath) != expectedSha256)
    {
        throw BridgeError{400, "INTEGRITY", "Upload integrity check failed"};
    }

    ApiSession session{mConfiguration, sessionValue};
    auto root = requireWritableRoot(session.api(), rootHandle);
    auto parent = resolveFolder(
        session.api(),
        *root,
        logicalPath.segments,
        logicalPath.segments.size() - 1,
        true);
    const auto& name = logicalPath.segments.back();
    static_cast<void>(sanitizedLeafName(name));
    requireVacantName(session.api(), *parent, name);

    auto cancelToken =
        MegaCancelTokenPtr{mega::MegaCancelToken::createInstance()};
    auto options =
        MegaUploadOptionsPtr{mega::MegaUploadOptions::createInstance()};
    options->fileName = name;
    options->startFirst = true;
    auto transfer = waitForTransfer(
        TransferKind::upload,
        *cancelToken,
        cancellationRequested,
        [&](auto* listener) {
            session.api().startUpload(
                localPath.string(),
                parent.get(),
                cancelToken.get(),
                options.get(),
                listener);
        });
    MegaNodePtr uploaded{
        session.api().getNodeByHandle(transfer->getNodeHandle())};
    if (!uploaded || uploaded->getSize() < 0 ||
        static_cast<std::uint64_t>(uploaded->getSize()) != expectedSize)
    {
        throw BridgeError{
            502,
            "INTEGRITY",
            "MEGA returned invalid upload metadata"};
    }
    const std::string hash{expectedSha256};
    std::unique_ptr<mega::MegaRequest> attribute{waitForRequest(
        [&](auto* listener) {
            session.api().setCustomNodeAttribute(
                uploaded.get(),
                "osh",
                hash.c_str(),
                listener);
        })};
    uploaded = requireNode(session.api(), nodeHandle(*uploaded));
    return fileFromNode(*uploaded, logicalPath.value);
}

File MegaClient::moveFile(
    std::string_view sessionValue,
    std::string_view rootHandle,
    std::string_view handle,
    std::string_view path) const
{
    const auto logicalPath = parseLogicalPath(path);
    if (logicalPath.segments.size() < 3)
    {
        throw BridgeError{400, "INVALID_PATH", "Invalid file path"};
    }
    ApiSession session{mConfiguration, sessionValue};
    auto root = requireWritableRoot(session.api(), rootHandle);
    auto node = requireNode(session.api(), handle);
    requireDescendant(session.api(), *root, *node);
    if (node->getType() != mega::MegaNode::TYPE_FILE)
    {
        throw BridgeError{400, "INVALID_FILE", "The MEGA node is not a file"};
    }
    auto parent = resolveFolder(
        session.api(),
        *root,
        logicalPath.segments,
        logicalPath.segments.size() - 1,
        true);
    const auto& name = logicalPath.segments.back();
    static_cast<void>(sanitizedLeafName(name));
    requireVacantName(
        session.api(),
        *parent,
        name,
        node->getHandle());
    if (node->getParentHandle() != parent->getHandle() ||
        copyString(node->getName()) != name)
    {
        std::unique_ptr<mega::MegaRequest> request{waitForRequest(
            [&](auto* listener) {
                session.api().moveNode(
                    node.get(),
                    parent.get(),
                    name.c_str(),
                    listener);
            })};
    }
    auto moved = requireNode(session.api(), handle);
    requireDescendant(session.api(), *root, *moved);
    return fileFromNode(*moved, logicalPath.value);
}

void MegaClient::removeFile(
    std::string_view sessionValue,
    std::string_view rootHandle,
    std::string_view handle) const
{
    ApiSession session{mConfiguration, sessionValue};
    auto root = requireWritableRoot(session.api(), rootHandle);
    auto node = requireNode(session.api(), handle);
    requireDescendant(session.api(), *root, *node);
    if (node->getType() != mega::MegaNode::TYPE_FILE)
    {
        throw BridgeError{400, "INVALID_FILE", "The MEGA node is not a file"};
    }
    auto parentHandle = node->getParentHandle();
    std::unique_ptr<mega::MegaRequest> request{waitForRequest(
        [&](auto* listener) { session.api().remove(node.get(), listener); })};
    while (parentHandle != root->getHandle())
    {
        auto parent = requireNode(session.api(), parentHandle);
        requireDescendant(session.api(), *root, *parent);
        if (parent->getType() != mega::MegaNode::TYPE_FOLDER)
        {
            break;
        }
        if (copyString(parent->getName()) == logical_root)
        {
            break;
        }
        MegaNodeListPtr children{session.api().getChildren(parent.get())};
        if (!children || children->size() != 0)
        {
            break;
        }
        parentHandle = parent->getParentHandle();
        std::unique_ptr<mega::MegaRequest> removeDirectory{waitForRequest(
            [&](auto* listener) {
                session.api().remove(parent.get(), listener);
            })};
    }
}

std::string sha256File(const std::filesystem::path& path)
{
    std::ifstream input{path, std::ios::binary};
    if (!input)
    {
        throw BridgeError{400, "INVALID_UPLOAD", "Unable to read the upload"};
    }
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context{
        EVP_MD_CTX_new(),
        EVP_MD_CTX_free};
    if (!context || EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr) != 1)
    {
        throw BridgeError{500, "CRYPTOGRAPHY", "Unable to initialize SHA-256"};
    }
    std::array<char, 64 * 1024> buffer{};
    while (input)
    {
        input.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        const auto count = input.gcount();
        if (count > 0 &&
            EVP_DigestUpdate(
                context.get(),
                buffer.data(),
                static_cast<std::size_t>(count)) != 1)
        {
            throw BridgeError{500, "CRYPTOGRAPHY", "Unable to hash the upload"};
        }
    }
    if (!input.eof())
    {
        throw BridgeError{400, "INVALID_UPLOAD", "Unable to read the upload"};
    }
    std::array<unsigned char, EVP_MAX_MD_SIZE> digest{};
    unsigned digestSize = 0;
    if (EVP_DigestFinal_ex(context.get(), digest.data(), &digestSize) != 1)
    {
        throw BridgeError{500, "CRYPTOGRAPHY", "Unable to hash the upload"};
    }
    std::ostringstream encoded;
    encoded << std::hex << std::setfill('0');
    for (unsigned index = 0; index < digestSize; ++index)
    {
        encoded << std::setw(2) << static_cast<unsigned>(digest[index]);
    }
    return encoded.str();
}

std::filesystem::path createTemporaryFile(
    const std::filesystem::path& directory,
    std::string_view purpose)
{
    std::filesystem::create_directories(directory);
    for (int attempt = 0; attempt < 16; ++attempt)
    {
        const auto path =
            directory /
            (sanitizedLeafName(purpose) + "-" + randomIdentifier() + ".tmp");
#ifdef _WIN32
        if (!std::filesystem::exists(path))
        {
            std::ofstream output{path, std::ios::binary};
            if (output)
            {
                output.close();
                return path;
            }
        }
#else
        const auto descriptor = ::open(
            path.c_str(),
            O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR);
        if (descriptor >= 0)
        {
            ::close(descriptor);
            return path;
        }
#endif
    }
    throw BridgeError{
        500,
        "TEMPORARY_STORAGE",
        "Unable to allocate temporary storage"};
}

void securelyRemove(const std::filesystem::path& path) noexcept
{
    std::error_code error;
    std::filesystem::remove(path, error);
}

} // namespace omnia::mega_bridge
