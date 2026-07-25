#include "mega_client.hpp"

#include "httplib.h"
#include <nlohmann/json.hpp>
#include <openssl/crypto.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace
{

using Json = nlohmann::json;
using omnia::mega_bridge::BridgeError;
using omnia::mega_bridge::File;
using omnia::mega_bridge::Folder;
using omnia::mega_bridge::MegaClient;
using omnia::mega_bridge::ServiceConfiguration;

constexpr std::string_view sessionHeader = "X-Omnia-Mega-Session";
constexpr std::size_t maximumCredentialBodyBytes = 16 * 1024;
volatile std::sig_atomic_t shutdownRequested = 0;
httplib::Server* activeServer = nullptr;

void requestShutdown(int)
{
    shutdownRequested = 1;
    if (activeServer != nullptr)
    {
        activeServer->stop();
    }
}

[[nodiscard]] bool transferCancelled(const httplib::Request& request)
{
    return shutdownRequested != 0 || request.is_connection_closed();
}

class SensitiveString final
{
public:
    explicit SensitiveString(std::string value): mValue{std::move(value)}
    {
    }

    ~SensitiveString()
    {
        if (!mValue.empty())
        {
            OPENSSL_cleanse(mValue.data(), mValue.size());
        }
    }

    SensitiveString(const SensitiveString&) = delete;
    SensitiveString& operator=(const SensitiveString&) = delete;

    [[nodiscard]] const std::string& value() const noexcept
    {
        return mValue;
    }

private:
    std::string mValue;
};

struct TemporaryPath
{
    std::filesystem::path value;

    ~TemporaryPath()
    {
        omnia::mega_bridge::securelyRemove(value);
    }
};

[[nodiscard]] Json folderJson(const Folder& folder)
{
    return {
        {"handle", folder.handle},
        {"name", folder.name},
        {"path", folder.path},
        {"canWrite", folder.canWrite}};
}

[[nodiscard]] Json fileJson(const File& file)
{
    Json value{
        {"handle", file.handle},
        {"path", file.path},
        {"revision", file.revision},
        {"size", file.size}};
    if (file.sha256)
    {
        value["sha256"] = *file.sha256;
    }
    return value;
}

void setJson(httplib::Response& response, const Json& value, int status = 200)
{
    response.status = status;
    response.set_content(value.dump(), "application/json; charset=utf-8");
}

void setError(
    httplib::Response& response,
    int status,
    std::string_view code)
{
    setJson(response, Json{{"code", code}}, status);
}

[[nodiscard]] std::string requiredString(
    const Json& value,
    std::string_view key,
    std::size_t maximum)
{
    const auto iterator = value.find(std::string{key});
    if (iterator == value.end() || !iterator->is_string())
    {
        throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
    }
    const auto result = iterator->get<std::string>();
    if (result.empty() || result.size() > maximum ||
        result.find('\0') != std::string::npos)
    {
        throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
    }
    return result;
}

[[nodiscard]] std::optional<std::string> optionalString(
    const Json& value,
    std::string_view key,
    std::size_t maximum)
{
    const auto iterator = value.find(std::string{key});
    if (iterator == value.end() || iterator->is_null())
    {
        return std::nullopt;
    }
    if (!iterator->is_string())
    {
        throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
    }
    auto result = iterator->get<std::string>();
    if (result.empty() || result.size() > maximum ||
        result.find('\0') != std::string::npos)
    {
        throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
    }
    return result;
}

[[nodiscard]] Json parseJsonBody(const httplib::Request& request)
{
    if (request.body.empty() ||
        request.body.size() > maximumCredentialBodyBytes)
    {
        throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
    }
    try
    {
        auto value = Json::parse(request.body);
        if (!value.is_object())
        {
            throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
        }
        return value;
    }
    catch (const Json::exception&)
    {
        throw BridgeError{400, "INVALID_REQUEST", "Invalid JSON request"};
    }
}

[[nodiscard]] std::string query(
    const httplib::Request& request,
    const char* name,
    std::size_t maximum = 2048)
{
    if (!request.has_param(name))
    {
        throw BridgeError{400, "INVALID_REQUEST", "A query parameter is missing"};
    }
    const auto value = request.get_param_value(name);
    if (value.empty() || value.size() > maximum ||
        value.find('\0') != std::string::npos)
    {
        throw BridgeError{400, "INVALID_REQUEST", "A query parameter is invalid"};
    }
    return value;
}

[[nodiscard]] std::string session(const httplib::Request& request)
{
    if (request.get_header_value_count(std::string{sessionHeader}) != 1)
    {
        throw BridgeError{
            401,
            "SESSION_EXPIRED",
            "The MEGA session is missing"};
    }
    const auto encoded =
        request.get_header_value(std::string{sessionHeader});
    const auto bytes = omnia::mega_bridge::decodeBase64Url(encoded);
    if (bytes.empty() || bytes.size() > 16 * 1024)
    {
        throw BridgeError{
            401,
            "SESSION_EXPIRED",
            "The MEGA session is invalid"};
    }
    std::string value;
    value.reserve(bytes.size());
    for (const auto byte: bytes)
    {
        value.push_back(static_cast<char>(byte));
    }
    if (value.find('\0') != std::string::npos)
    {
        throw BridgeError{
            401,
            "SESSION_EXPIRED",
            "The MEGA session is invalid"};
    }
    return value;
}

void streamFile(
    httplib::Response& response,
    const omnia::mega_bridge::Download& download)
{
    const auto path =
        std::make_shared<std::filesystem::path>(download.path);
    response.set_content_provider(
        static_cast<std::size_t>(download.size),
        "application/octet-stream",
        [path](
            std::size_t offset,
            std::size_t length,
            httplib::DataSink& sink) {
            std::ifstream input{*path, std::ios::binary};
            if (!input)
            {
                return false;
            }
            input.seekg(static_cast<std::streamoff>(offset));
            std::array<char, 64 * 1024> buffer{};
            auto remaining = length;
            while (remaining > 0)
            {
                const auto wanted = std::min(remaining, buffer.size());
                input.read(
                    buffer.data(),
                    static_cast<std::streamsize>(wanted));
                const auto count = input.gcount();
                if (count <= 0 ||
                    !sink.write(
                        buffer.data(),
                        static_cast<std::size_t>(count)))
                {
                    return false;
                }
                remaining -= static_cast<std::size_t>(count);
            }
            return true;
        },
        [path](bool) {
            omnia::mega_bridge::securelyRemove(*path);
            std::error_code error;
            std::filesystem::remove(path->parent_path(), error);
        });
}

void configureRoutes(
    httplib::Server& server,
    const ServiceConfiguration& configuration,
    MegaClient& client)
{
    server.Post(
        "/v1/sessions",
        [&client](const httplib::Request& request, httplib::Response& response) {
            auto body = parseJsonBody(request);
            const auto email = requiredString(body, "email", 320);
            if (email.find('@') == std::string::npos)
            {
                throw BridgeError{
                    400,
                    "INVALID_REQUEST",
                    "Invalid JSON request"};
            }
            SensitiveString password{requiredString(body, "password", 1024)};
            auto& passwordInBody =
                body["password"].get_ref<std::string&>();
            OPENSSL_cleanse(
                passwordInBody.data(),
                passwordInBody.size());
            passwordInBody.clear();
            const auto multiFactorCode =
                optionalString(body, "multiFactorCode", 16);
            if (multiFactorCode &&
                (multiFactorCode->size() != 6 ||
                 !std::ranges::all_of(
                     *multiFactorCode,
                     [](unsigned char character) {
                         return character >= '0' && character <= '9';
                     })))
            {
                throw BridgeError{
                    400,
                    "INVALID_REQUEST",
                    "Invalid JSON request"};
            }
            const auto result =
                client.login(email, password.value(), multiFactorCode);
            setJson(
                response,
                Json{
                    {"account", result.account},
                    {"session", result.session}});
        });

    server.Delete(
        "/v1/session",
        [&client](const httplib::Request& request, httplib::Response& response) {
            client.logout(session(request));
            response.status = 204;
        });

    server.Get(
        "/v1/folders",
        [&client](const httplib::Request& request, httplib::Response& response) {
            Json values = Json::array();
            for (const auto& folder: client.folders(session(request)))
            {
                values.push_back(folderJson(folder));
            }
            setJson(response, Json{{"folders", std::move(values)}});
        });

    server.Get(
        "/v1/files",
        [&client](const httplib::Request& request, httplib::Response& response) {
            Json values = Json::array();
            for (const auto& file:
                 client.files(
                     session(request),
                     query(request, "rootHandle", 128),
                     query(request, "prefix")))
            {
                values.push_back(fileJson(file));
            }
            setJson(response, Json{{"files", std::move(values)}});
        });

    server.Get(
        R"(/v1/files/([^/]+))",
        [&client](const httplib::Request& request, httplib::Response& response) {
            const auto download = client.downloadFile(
                session(request),
                query(request, "rootHandle", 128),
                request.matches[1].str(),
                [&request] { return transferCancelled(request); });
            streamFile(response, download);
        });

    server.Post(
        "/v1/files",
        [&configuration, &client](
            const httplib::Request& request,
            httplib::Response& response,
            const httplib::ContentReader& contentReader) {
            if (request.get_header_value_count("Content-Length") != 1 ||
                request.get_header_value_count("X-Omnia-SHA256") != 1)
            {
                throw BridgeError{
                    400,
                    "INTEGRITY",
                    "Upload integrity metadata is required"};
            }
            const auto expectedSize =
                omnia::mega_bridge::parseUnsignedDecimal(
                    request.get_header_value("Content-Length"),
                    configuration.maximumPublicationBytes,
                    "content length");
            const auto expectedHash =
                request.get_header_value("X-Omnia-SHA256");
            TemporaryPath temporary{
                omnia::mega_bridge::createTemporaryFile(
                    configuration.temporaryDirectory,
                    "upload")};
            std::ofstream output{
                temporary.value,
                std::ios::binary | std::ios::trunc};
            if (!output)
            {
                throw BridgeError{
                    500,
                    "TEMPORARY_STORAGE",
                    "Unable to store the upload"};
            }
            std::uint64_t received = 0;
            const auto complete = contentReader(
                [&](const char* data, std::size_t length) {
                    if (length >
                            configuration.maximumPublicationBytes - received ||
                        received + length > expectedSize)
                    {
                        return false;
                    }
                    output.write(
                        data,
                        static_cast<std::streamsize>(length));
                    received += length;
                    return static_cast<bool>(output);
                });
            output.close();
            if (!complete || received != expectedSize)
            {
                throw BridgeError{
                    400,
                    "INTEGRITY",
                    "Upload length did not match Content-Length"};
            }
            const auto uploaded = client.uploadFile(
                session(request),
                query(request, "rootHandle", 128),
                query(request, "path"),
                temporary.value,
                expectedSize,
                expectedHash,
                [&request] { return transferCancelled(request); });
            setJson(response, fileJson(uploaded), 201);
        });

    server.Put(
        R"(/v1/files/([^/]+))",
        [&client](const httplib::Request& request, httplib::Response& response) {
            const auto moved = client.moveFile(
                session(request),
                query(request, "rootHandle", 128),
                request.matches[1].str(),
                query(request, "path"));
            setJson(response, fileJson(moved));
        });

    server.Delete(
        R"(/v1/files/([^/]+))",
        [&client](const httplib::Request& request, httplib::Response& response) {
            client.removeFile(
                session(request),
                query(request, "rootHandle", 128),
                request.matches[1].str());
            response.status = 204;
        });
}

} // namespace

int main()
{
    try
    {
        const auto configuration =
            omnia::mega_bridge::configurationFromEnvironment();
        MegaClient client{configuration};
        httplib::Server server;
        server.new_task_queue = [&configuration] {
            return new httplib::ThreadPool(
                configuration.maximumConcurrentRequests,
                configuration.maximumConcurrentRequests,
                configuration.maximumQueuedRequests);
        };
        server.set_payload_max_length(
            static_cast<std::size_t>(configuration.maximumPublicationBytes));
        server.set_read_timeout(std::chrono::minutes{5});
        server.set_write_timeout(std::chrono::minutes{5});
        server.set_idle_interval(std::chrono::seconds{1});
        server.set_pre_routing_handler(
            [&configuration](
                const httplib::Request& request,
                httplib::Response& response) {
                response.set_header("Cache-Control", "no-store");
                response.set_header("X-Content-Type-Options", "nosniff");
                if (request.get_header_value_count("Authorization") != 1)
                {
                    setError(response, 401, "UNAUTHORIZED");
                    return httplib::Server::HandlerResponse::Handled;
                }
                const auto expected =
                    "Bearer " + configuration.bridgeToken;
                if (!omnia::mega_bridge::constantTimeEquals(
                        request.get_header_value("Authorization"),
                        expected))
                {
                    setError(response, 401, "UNAUTHORIZED");
                    return httplib::Server::HandlerResponse::Handled;
                }
                if (request.path == "/v1/sessions")
                {
                    try
                    {
                        if (request.get_header_value_count("Content-Length") !=
                                1 ||
                            omnia::mega_bridge::parseUnsignedDecimal(
                                request.get_header_value("Content-Length"),
                                maximumCredentialBodyBytes,
                                "content length") == 0)
                        {
                            setError(response, 400, "INVALID_REQUEST");
                            return httplib::Server::HandlerResponse::Handled;
                        }
                    }
                    catch (const BridgeError&)
                    {
                        setError(response, 413, "REQUEST_TOO_LARGE");
                        return httplib::Server::HandlerResponse::Handled;
                    }
                }
                return httplib::Server::HandlerResponse::Unhandled;
            });
        server.set_exception_handler(
            [](const httplib::Request&,
               httplib::Response& response,
               std::exception_ptr exception) {
                try
                {
                    std::rethrow_exception(exception);
                }
                catch (const BridgeError& error)
                {
                    setError(response, error.status(), error.code());
                }
                catch (...)
                {
                    setError(response, 500, "INTERNAL");
                }
            });
        server.set_error_handler(
            [](const httplib::Request&, httplib::Response& response) {
                if (response.status == 404)
                {
                    setError(response, 404, "NOT_FOUND");
                }
            });
        configureRoutes(server, configuration, client);
        activeServer = &server;
        const auto previousInterrupt = std::signal(SIGINT, requestShutdown);
        const auto previousTerminate = std::signal(SIGTERM, requestShutdown);
        if (previousInterrupt == SIG_ERR || previousTerminate == SIG_ERR)
        {
            activeServer = nullptr;
            std::cerr << "MEGA bridge failed to install shutdown handlers\n";
            return 1;
        }
        const auto listened =
            server.listen(configuration.host, configuration.port);
        activeServer = nullptr;
        std::signal(SIGINT, previousInterrupt);
        std::signal(SIGTERM, previousTerminate);
        if (!listened && shutdownRequested == 0)
        {
            std::cerr << "MEGA bridge failed to bind its configured endpoint\n";
            return 1;
        }
        return 0;
    }
    catch (const std::exception&)
    {
        std::cerr << "MEGA bridge failed to initialize\n";
        return 1;
    }
}
