#pragma once

#include "omnia/bridge_core.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::mega_bridge
{

using CancellationRequested = std::function<bool()>;

struct LoginResult
{
    std::string account;
    std::string session;
};

struct Folder
{
    std::string handle;
    std::string name;
    std::string path;
    bool canWrite;
};

struct File
{
    std::string handle;
    std::string path;
    std::string revision;
    std::uint64_t size;
    std::optional<std::string> sha256;
};

struct Download
{
    std::filesystem::path path;
    std::uint64_t size;
};

class MegaClient final
{
public:
    explicit MegaClient(ServiceConfiguration configuration);

    [[nodiscard]] LoginResult login(
        std::string_view email,
        const std::string& password,
        const std::optional<std::string>& multiFactorCode) const;
    void logout(std::string_view session) const;

    [[nodiscard]] std::vector<Folder> folders(std::string_view session) const;
    [[nodiscard]] std::vector<File> files(
        std::string_view session,
        std::string_view rootHandle,
        std::string_view prefix) const;
    [[nodiscard]] Download downloadFile(
        std::string_view session,
        std::string_view rootHandle,
        std::string_view handle,
        CancellationRequested cancellationRequested = {}) const;
    [[nodiscard]] File uploadFile(
        std::string_view session,
        std::string_view rootHandle,
        std::string_view path,
        const std::filesystem::path& localPath,
        std::uint64_t expectedSize,
        std::string_view expectedSha256,
        CancellationRequested cancellationRequested = {}) const;
    [[nodiscard]] File moveFile(
        std::string_view session,
        std::string_view rootHandle,
        std::string_view handle,
        std::string_view path) const;
    void removeFile(
        std::string_view session,
        std::string_view rootHandle,
        std::string_view handle) const;

private:
    ServiceConfiguration mConfiguration;
};

[[nodiscard]] std::string sha256File(const std::filesystem::path& path);
[[nodiscard]] std::filesystem::path createTemporaryFile(
    const std::filesystem::path& directory,
    std::string_view purpose);
void securelyRemove(const std::filesystem::path& path) noexcept;

} // namespace omnia::mega_bridge
