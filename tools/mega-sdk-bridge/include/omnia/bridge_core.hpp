#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::mega_bridge
{

inline constexpr std::string_view logical_root = ".omnia-reader/v1";
inline constexpr std::size_t maximum_logical_path_bytes = 2048;

class BridgeError final: public std::runtime_error
{
public:
    BridgeError(int status, std::string code, std::string message);

    [[nodiscard]] int status() const noexcept;
    [[nodiscard]] const std::string& code() const noexcept;

private:
    int mStatus;
    std::string mCode;
};

struct LogicalPath
{
    std::string value;
    std::vector<std::string> segments;
};

struct ServiceConfiguration
{
    std::string appKey;
    std::string bridgeToken;
    std::string host{"127.0.0.1"};
    std::uint16_t port{47831};
    std::filesystem::path temporaryDirectory;
    std::uint64_t maximumPublicationBytes{2ULL * 1024ULL * 1024ULL * 1024ULL};
    std::size_t maximumConcurrentRequests{4};
    std::size_t maximumQueuedRequests{32};
};

[[nodiscard]] LogicalPath parseLogicalPath(std::string_view value);
[[nodiscard]] bool isPathWithin(
    const std::filesystem::path& root,
    const std::filesystem::path& candidate);
[[nodiscard]] bool constantTimeEquals(
    std::string_view left,
    std::string_view right) noexcept;
[[nodiscard]] std::vector<std::byte> decodeBase64Url(std::string_view value);
[[nodiscard]] std::string encodeBase64Url(std::span<const std::byte> value);
[[nodiscard]] std::uint64_t parseUnsignedDecimal(
    std::string_view value,
    std::uint64_t maximum,
    std::string_view field);
[[nodiscard]] ServiceConfiguration configurationFromEnvironment();
[[nodiscard]] std::string sanitizedLeafName(std::string_view value);
void prepareTemporaryDirectory(const std::filesystem::path& directory);

} // namespace omnia::mega_bridge
