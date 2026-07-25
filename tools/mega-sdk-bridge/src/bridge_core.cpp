#include "omnia/bridge_core.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdlib>
#include <limits>
#include <system_error>

namespace omnia::mega_bridge
{
namespace
{

constexpr std::string_view base64Alphabet{
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"};

[[nodiscard]] std::optional<std::string> environment(std::string_view key)
{
    const auto* value = std::getenv(std::string{key}.c_str());
    if (value == nullptr || *value == '\0')
    {
        return std::nullopt;
    }
    return std::string{value};
}

[[nodiscard]] std::string requiredEnvironment(std::string_view key)
{
    const auto value = environment(key);
    if (!value)
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            std::string{key} + " is required"};
    }
    return *value;
}

[[nodiscard]] std::uint64_t configurationUnsigned(
    std::string_view key,
    std::string_view fallback,
    std::uint64_t maximum)
{
    try
    {
        return parseUnsignedDecimal(
            environment(key).value_or(std::string{fallback}),
            maximum,
            key);
    }
    catch (const BridgeError&)
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            std::string{key} + " is invalid"};
    }
}

[[nodiscard]] bool isHexadecimal(std::string_view value)
{
    return std::ranges::all_of(
        value,
        [](unsigned char character) {
            return (character >= '0' && character <= '9') ||
                   (character >= 'a' && character <= 'f');
        });
}

[[nodiscard]] bool isManagedTemporaryEntry(std::string_view name)
{
    constexpr std::size_t identifierBytes = 36;
    const auto matches = [name](
                             std::string_view prefix,
                             std::string_view suffix = {}) {
        if (!name.starts_with(prefix) || !name.ends_with(suffix) ||
            name.size() != prefix.size() + identifierBytes + suffix.size())
        {
            return false;
        }
        return isHexadecimal(
            name.substr(prefix.size(), identifierBytes));
    };
    return matches("upload-", ".tmp") || matches("download-") ||
           matches("sdk-");
}

[[nodiscard]] int base64Value(char character)
{
    if (character >= 'A' && character <= 'Z')
    {
        return character - 'A';
    }
    if (character >= 'a' && character <= 'z')
    {
        return character - 'a' + 26;
    }
    if (character >= '0' && character <= '9')
    {
        return character - '0' + 52;
    }
    if (character == '+' || character == '-')
    {
        return 62;
    }
    if (character == '/' || character == '_')
    {
        return 63;
    }
    return -1;
}

} // namespace

BridgeError::BridgeError(int status, std::string code, std::string message):
    std::runtime_error{std::move(message)},
    mStatus{status},
    mCode{std::move(code)}
{
}

int BridgeError::status() const noexcept
{
    return mStatus;
}

const std::string& BridgeError::code() const noexcept
{
    return mCode;
}

LogicalPath parseLogicalPath(std::string_view value)
{
    if (value.empty() || value.size() > maximum_logical_path_bytes ||
        value.find('\\') != std::string_view::npos ||
        value.find('%') != std::string_view::npos ||
        value.find('\0') != std::string_view::npos)
    {
        throw BridgeError{400, "INVALID_PATH", "Invalid logical path"};
    }

    std::vector<std::string> segments;
    std::size_t begin = 0;
    while (begin <= value.size())
    {
        const auto separator = value.find('/', begin);
        const auto end =
            separator == std::string_view::npos ? value.size() : separator;
        const auto segment = value.substr(begin, end - begin);
        if (segment.empty() || segment == "." || segment == "..")
        {
            throw BridgeError{400, "INVALID_PATH", "Invalid logical path"};
        }
        segments.emplace_back(segment);
        if (separator == std::string_view::npos)
        {
            break;
        }
        begin = separator + 1;
    }

    if (segments.size() < 2 || segments[0] != ".omnia-reader" ||
        segments[1] != "v1")
    {
        throw BridgeError{400, "INVALID_PATH", "Invalid logical path"};
    }
    return {std::string{value}, std::move(segments)};
}

bool isPathWithin(
    const std::filesystem::path& root,
    const std::filesystem::path& candidate)
{
    const auto normalizedRoot = std::filesystem::weakly_canonical(root);
    const auto normalizedCandidate = std::filesystem::weakly_canonical(candidate);
    auto rootIterator = normalizedRoot.begin();
    auto candidateIterator = normalizedCandidate.begin();
    for (; rootIterator != normalizedRoot.end(); ++rootIterator, ++candidateIterator)
    {
        if (candidateIterator == normalizedCandidate.end() ||
            *rootIterator != *candidateIterator)
        {
            return false;
        }
    }
    return true;
}

bool constantTimeEquals(
    std::string_view left,
    std::string_view right) noexcept
{
    const auto maximum = std::max(left.size(), right.size());
    unsigned difference =
        static_cast<unsigned>(left.size() ^ right.size());
    for (std::size_t index = 0; index < maximum; ++index)
    {
        const auto leftByte =
            index < left.size() ? static_cast<unsigned char>(left[index]) : 0U;
        const auto rightByte =
            index < right.size() ? static_cast<unsigned char>(right[index]) : 0U;
        difference |= static_cast<unsigned>(leftByte ^ rightByte);
    }
    return difference == 0U;
}

std::vector<std::byte> decodeBase64Url(std::string_view value)
{
    if (value.empty() || value.size() > 32 * 1024 || value.size() % 4 == 1 ||
        value.find('=') != std::string_view::npos ||
        value.find('+') != std::string_view::npos ||
        value.find('/') != std::string_view::npos)
    {
        throw BridgeError{400, "INVALID_SESSION", "Invalid session encoding"};
    }

    std::vector<std::byte> decoded;
    decoded.reserve(value.size() * 3 / 4);
    std::uint32_t accumulator = 0;
    unsigned bits = 0;
    for (const auto character: value)
    {
        const auto digit = base64Value(character);
        if (digit < 0)
        {
            throw BridgeError{400, "INVALID_SESSION", "Invalid session encoding"};
        }
        accumulator = (accumulator << 6U) | static_cast<std::uint32_t>(digit);
        bits += 6U;
        if (bits >= 8U)
        {
            bits -= 8U;
            decoded.push_back(static_cast<std::byte>(
                (accumulator >> bits) & 0xffU));
        }
    }
    if (bits != 0U && (accumulator & ((1U << bits) - 1U)) != 0U)
    {
        throw BridgeError{400, "INVALID_SESSION", "Invalid session encoding"};
    }
    return decoded;
}

std::string encodeBase64Url(std::span<const std::byte> value)
{
    std::string encoded;
    encoded.reserve((value.size() * 4 + 2) / 3);
    std::uint32_t accumulator = 0;
    unsigned bits = 0;
    for (const auto byte: value)
    {
        accumulator =
            (accumulator << 8U) | static_cast<std::uint32_t>(byte);
        bits += 8U;
        while (bits >= 6U)
        {
            bits -= 6U;
            encoded.push_back(base64Alphabet[(accumulator >> bits) & 0x3fU]);
        }
    }
    if (bits != 0U)
    {
        encoded.push_back(base64Alphabet[(accumulator << (6U - bits)) & 0x3fU]);
    }
    std::replace(encoded.begin(), encoded.end(), '+', '-');
    std::replace(encoded.begin(), encoded.end(), '/', '_');
    return encoded;
}

std::uint64_t parseUnsignedDecimal(
    std::string_view value,
    std::uint64_t maximum,
    std::string_view field)
{
    if (value.empty())
    {
        throw BridgeError{
            400,
            "INVALID_REQUEST",
            std::string{"Invalid "} + std::string{field}};
    }
    std::uint64_t parsed = 0;
    const auto [end, error] =
        std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (error != std::errc{} || end != value.data() + value.size() ||
        parsed > maximum)
    {
        throw BridgeError{
            400,
            "INVALID_REQUEST",
            std::string{"Invalid "} + std::string{field}};
    }
    return parsed;
}

ServiceConfiguration configurationFromEnvironment()
{
    ServiceConfiguration configuration;
    configuration.appKey = requiredEnvironment("OMNIA_MEGA_APP_KEY");
    configuration.bridgeToken =
        requiredEnvironment("OMNIA_MEGA_BRIDGE_TOKEN");
    if (configuration.bridgeToken.size() < 32 ||
        configuration.bridgeToken.size() > 4096)
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "OMNIA_MEGA_BRIDGE_TOKEN must contain 32 through 4096 bytes"};
    }
    configuration.host =
        environment("OMNIA_MEGA_BRIDGE_HOST").value_or("127.0.0.1");
    if (configuration.host != "127.0.0.1" &&
        configuration.host != "::1")
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "OMNIA_MEGA_BRIDGE_HOST must be a loopback host"};
    }
    const auto port = configurationUnsigned(
        "OMNIA_MEGA_BRIDGE_PORT",
        "47831",
        std::numeric_limits<std::uint16_t>::max());
    if (port == 0)
    {
        throw BridgeError{500, "CONFIGURATION", "Bridge port must be positive"};
    }
    configuration.port = static_cast<std::uint16_t>(port);
    configuration.temporaryDirectory =
        environment("OMNIA_MEGA_BRIDGE_TMP").value_or(
            (std::filesystem::temp_directory_path() /
             "omnia-mega-sdk-bridge")
                .string());
    if (!configuration.temporaryDirectory.is_absolute())
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "OMNIA_MEGA_BRIDGE_TMP must be an absolute private directory"};
    }
    configuration.temporaryDirectory =
        configuration.temporaryDirectory.lexically_normal();
    if (configuration.temporaryDirectory ==
        configuration.temporaryDirectory.root_path())
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "OMNIA_MEGA_BRIDGE_TMP cannot be a filesystem root"};
    }
    configuration.maximumPublicationBytes = configurationUnsigned(
        "OMNIA_MEGA_MAX_PUBLICATION_BYTES",
        "2147483648",
        16ULL * 1024ULL * 1024ULL * 1024ULL);
    if (configuration.maximumPublicationBytes == 0)
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "OMNIA_MEGA_MAX_PUBLICATION_BYTES must be positive"};
    }
    if (configuration.maximumPublicationBytes >
        std::numeric_limits<std::size_t>::max())
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "OMNIA_MEGA_MAX_PUBLICATION_BYTES exceeds this platform"};
    }
    configuration.maximumConcurrentRequests = static_cast<std::size_t>(
        configurationUnsigned(
            "OMNIA_MEGA_MAX_CONCURRENT_REQUESTS",
            "4",
            32));
    configuration.maximumQueuedRequests = static_cast<std::size_t>(
        configurationUnsigned(
            "OMNIA_MEGA_MAX_QUEUED_REQUESTS",
            "32",
            1024));
    if (configuration.maximumConcurrentRequests == 0 ||
        configuration.maximumQueuedRequests == 0)
    {
        throw BridgeError{
            500,
            "CONFIGURATION",
            "MEGA bridge concurrency limits must be positive"};
    }
    return configuration;
}

std::string sanitizedLeafName(std::string_view value)
{
    if (value.empty() || value.size() > 255 || value == "." || value == ".." ||
        value.find('/') != std::string_view::npos ||
        value.find('\\') != std::string_view::npos ||
        value.find('\0') != std::string_view::npos)
    {
        throw BridgeError{400, "INVALID_PATH", "Invalid path segment"};
    }
    return std::string{value};
}

void prepareTemporaryDirectory(const std::filesystem::path& directory)
{
    std::error_code error;
    const auto status = std::filesystem::symlink_status(directory, error);
    if (!error && std::filesystem::exists(status))
    {
        if (!std::filesystem::is_directory(status) ||
            std::filesystem::is_symlink(status))
        {
            throw BridgeError{
                500,
                "CONFIGURATION",
                "The MEGA bridge temporary path is not a private directory"};
        }
        constexpr auto publicPermissions =
            std::filesystem::perms::group_all |
            std::filesystem::perms::others_all;
        if ((status.permissions() & publicPermissions) !=
            std::filesystem::perms::none)
        {
            throw BridgeError{
                500,
                "CONFIGURATION",
                "The MEGA bridge temporary directory is not private"};
        }
    }
    else
    {
        error.clear();
        if (!std::filesystem::create_directories(directory, error) || error)
        {
            throw BridgeError{
                500,
                "TEMPORARY_STORAGE",
                "Unable to create private temporary storage"};
        }
        std::filesystem::permissions(
            directory,
            std::filesystem::perms::owner_all,
            std::filesystem::perm_options::replace,
            error);
        if (error)
        {
            throw BridgeError{
                500,
                "TEMPORARY_STORAGE",
                "Unable to secure private temporary storage"};
        }
    }

    std::filesystem::directory_iterator entries{directory, error};
    if (error)
    {
        throw BridgeError{
            500,
            "TEMPORARY_STORAGE",
            "Unable to inspect private temporary storage"};
    }
    for (const auto& entry: entries)
    {
        const auto name = entry.path().filename().string();
        if (!isManagedTemporaryEntry(name))
        {
            throw BridgeError{
                500,
                "CONFIGURATION",
                "The MEGA bridge temporary directory contains unmanaged data"};
        }
        std::filesystem::remove_all(entry.path(), error);
        if (error)
        {
            throw BridgeError{
                500,
                "TEMPORARY_STORAGE",
                "Unable to remove stale temporary data"};
        }
    }
}

} // namespace omnia::mega_bridge
