cmake_minimum_required(VERSION 3.20)

project(
  omnia_mega_sdk_bridge
  VERSION 0.1.0
  DESCRIPTION "Private official-MEGA-SDK bridge for Omnia Reader"
  LANGUAGES CXX
)

option(
  OMNIA_MEGA_BRIDGE_BUILD_SERVICE
  "Build the service that links the official MEGA SDK"
  ON
)
option(OMNIA_MEGA_BRIDGE_BUILD_TESTS "Build deterministic core tests" ON)

add_library(omnia_mega_bridge_core src/bridge_core.cpp)
add_library(Omnia::MegaBridgeCore ALIAS omnia_mega_bridge_core)
target_include_directories(
  omnia_mega_bridge_core
  PUBLIC
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
)
target_compile_features(omnia_mega_bridge_core PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(omnia_mega_bridge_core PRIVATE /W4 /permissive-)
else()
  target_compile_options(
    omnia_mega_bridge_core
    PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
  )
endif()

if(OMNIA_MEGA_BRIDGE_BUILD_TESTS)
  include(CTest)
  add_executable(omnia_mega_bridge_core_tests tests/bridge_core_tests.cpp)
  target_link_libraries(
    omnia_mega_bridge_core_tests
    PRIVATE Omnia::MegaBridgeCore
  )
  add_test(
    NAME omnia_mega_bridge_core_tests
    COMMAND omnia_mega_bridge_core_tests
  )
endif()

if(OMNIA_MEGA_BRIDGE_BUILD_SERVICE)
  include(FetchContent)

  # Pinned commits, not mutable branches or release labels.
  FetchContent_Declare(
    mega_sdk
    GIT_REPOSITORY https://github.com/meganz/sdk.git
    GIT_TAG 51954a44aa3cfd8f0e2e5a82c23083d8cc250cc5
    GIT_SHALLOW FALSE
  )
  FetchContent_Declare(
    cpp_httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
    GIT_TAG d66d9a95997d51a8ba9822a611d1267757741535
    GIT_SHALLOW FALSE
  )
  set(HTTPLIB_INSTALL OFF CACHE BOOL "" FORCE)
  set(HTTPLIB_TEST OFF CACHE BOOL "" FORCE)

  FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG 55f93686c01528224f448c19128836e7df245f72
    GIT_SHALLOW FALSE
  )
  set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
  set(JSON_Install OFF CACHE BOOL "" FORCE)

  # The bridge needs cloud transfers only; omit unrelated SDK surfaces.
  set(ENABLE_SYNC OFF CACHE BOOL "" FORCE)
  set(ENABLE_CHAT OFF CACHE BOOL "" FORCE)
  set(ENABLE_JAVA_BINDINGS OFF CACHE BOOL "" FORCE)
  set(ENABLE_QT_BINDINGS OFF CACHE BOOL "" FORCE)
  set(ENABLE_SDKLIB_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(ENABLE_SDKLIB_TESTS OFF CACHE BOOL "" FORCE)
  set(ENABLE_SDKLIB_WERROR OFF CACHE BOOL "" FORCE)
  set(ENABLE_MEDIA_FILE_METADATA OFF CACHE BOOL "" FORCE)
  set(USE_FFMPEG OFF CACHE BOOL "" FORCE)
  set(USE_FREEIMAGE OFF CACHE BOOL "" FORCE)
  set(USE_LIBUV OFF CACHE BOOL "" FORCE)
  set(USE_PDFIUM OFF CACHE BOOL "" FORCE)
  set(USE_READLINE OFF CACHE BOOL "" FORCE)

  FetchContent_MakeAvailable(mega_sdk cpp_httplib nlohmann_json)

  find_package(OpenSSL REQUIRED COMPONENTS Crypto)
  find_package(Threads REQUIRED)

  add_executable(
    omnia-mega-sdk-bridge
    src/main.cpp
    src/mega_client.cpp
  )
  target_link_libraries(
    omnia-mega-sdk-bridge
    PRIVATE
      Omnia::MegaBridgeCore
      MEGA::SDKlib
      httplib::httplib
      nlohmann_json::nlohmann_json
      OpenSSL::Crypto
      Threads::Threads
  )
  target_compile_features(omnia-mega-sdk-bridge PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(omnia-mega-sdk-bridge PRIVATE /W4 /permissive-)
  else()
    target_compile_options(
      omnia-mega-sdk-bridge
      PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
    )
  endif()
endif()
