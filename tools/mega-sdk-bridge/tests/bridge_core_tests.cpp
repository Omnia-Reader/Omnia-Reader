#include "omnia/bridge_core.hpp"

#include <array>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace
{

int failures = 0;

void check(bool condition, std::string_view message)
{
    if (!condition)
    {
        ++failures;
        std::cerr << "FAIL: " << message << '\n';
    }
}

template<typename Function>
void checkBridgeError(
    Function&& function,
    int status,
    std::string_view code,
    std::string_view message)
{
    try
    {
        function();
        check(false, message);
    }
    catch (const omnia::mega_bridge::BridgeError& error)
    {
        check(error.status() == status, message);
        check(error.code() == code, message);
    }
}

} // namespace

int main()
{
    using namespace omnia::mega_bridge;

    const auto path =
        parseLogicalPath(".omnia-reader/v1/books/ab/book/edition.epub");
    check(path.segments.size() == 6, "logical path segment count");
    check(path.segments[2] == "books", "logical path preserves segments");

    for (const auto invalid:
         {"", "/.omnia-reader/v1/a", ".omnia-reader/v2/a",
          ".omnia-reader/v1/../secret", ".omnia-reader/v1//a",
          ".omnia-reader/v1/a\\b", ".omnia-reader/v1/a%2fb"})
    {
        checkBridgeError(
            [&] { static_cast<void>(parseLogicalPath(invalid)); },
            400,
            "INVALID_PATH",
            "reject invalid logical path");
    }

    check(
        constantTimeEquals("same-secret", "same-secret"),
        "constant-time equality accepts equal values");
    check(
        !constantTimeEquals("same-secret", "other-secret"),
        "constant-time equality rejects different values");
    check(
        !constantTimeEquals("short", "shorter"),
        "constant-time equality includes length");

    const std::array<std::byte, 8> bytes{
        std::byte{'s'},
        std::byte{'e'},
        std::byte{'s'},
        std::byte{'s'},
        std::byte{'i'},
        std::byte{'o'},
        std::byte{'n'},
        std::byte{0xff}};
    const auto encoded = encodeBase64Url(bytes);
    check(encoded.find('=') == std::string::npos, "base64url is unpadded");
    check(decodeBase64Url(encoded) == std::vector<std::byte>{bytes.begin(), bytes.end()},
          "base64url round trip");
    checkBridgeError(
        [] { static_cast<void>(decodeBase64Url("***")); },
        400,
        "INVALID_SESSION",
        "reject malformed base64url");
    for (const auto invalid: {"c2Vzc2lvbg==", "c2Vzc2lvbg+/", "a"})
    {
        checkBridgeError(
            [&] { static_cast<void>(decodeBase64Url(invalid)); },
            400,
            "INVALID_SESSION",
            "reject padded or non-url-safe session encoding");
    }

    check(
        parseUnsignedDecimal("2147483648", 2147483648ULL, "size") ==
            2147483648ULL,
        "parse bounded unsigned decimal");
    checkBridgeError(
        [] {
            static_cast<void>(
                parseUnsignedDecimal("-1", 100, "size"));
        },
        400,
        "INVALID_REQUEST",
        "reject signed decimal");
    checkBridgeError(
        [] {
            static_cast<void>(
                parseUnsignedDecimal("101", 100, "size"));
        },
        400,
        "INVALID_REQUEST",
        "reject oversized decimal");

    check(sanitizedLeafName("edition.epub") == "edition.epub", "valid leaf");
    checkBridgeError(
        [] { static_cast<void>(sanitizedLeafName("../book")); },
        400,
        "INVALID_PATH",
        "reject path-like leaf");

    const auto temporary =
        std::filesystem::temp_directory_path() / "omnia-bridge-core-test";
    check(
        isPathWithin(temporary, temporary / "nested" / "file"),
        "accept path below root");
    check(
        !isPathWithin(temporary, temporary.parent_path() / "escape"),
        "reject path outside root");

    const auto storage = temporary / "storage";
    std::error_code cleanupError;
    std::filesystem::remove_all(storage, cleanupError);
    prepareTemporaryDirectory(storage);
    check(
        std::filesystem::is_directory(storage),
        "create private temporary directory");

    const std::string identifier(36, 'a');
    {
        std::ofstream upload{storage / ("upload-" + identifier + ".tmp")};
        upload << "partial";
    }
    std::filesystem::create_directories(
        storage / ("download-" + identifier));
    std::filesystem::create_directories(storage / ("sdk-" + identifier));
    prepareTemporaryDirectory(storage);
    check(
        std::filesystem::is_empty(storage),
        "remove recognized crash remnants");

    {
        std::ofstream unmanaged{storage / "owner-note"};
        unmanaged << "keep";
    }
    checkBridgeError(
        [&] { prepareTemporaryDirectory(storage); },
        500,
        "CONFIGURATION",
        "reject unmanaged temporary directory data");
    check(
        std::filesystem::exists(storage / "owner-note"),
        "preserve unmanaged temporary directory data");
    std::filesystem::remove_all(storage, cleanupError);

    return failures == 0 ? 0 : 1;
}
