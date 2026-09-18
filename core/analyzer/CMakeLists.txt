cmake_minimum_required(VERSION 3.16)
project(codecraft_analyzer VERSION 2.5.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(codecraft_analyzer_core STATIC
  src/lexer.cpp
  src/analyzer.cpp
)
target_include_directories(codecraft_analyzer_core PUBLIC include)
target_compile_options(codecraft_analyzer_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(codecraft-analyzer src/main.cpp)
target_link_libraries(codecraft-analyzer PRIVATE codecraft_analyzer_core)
target_compile_options(codecraft-analyzer PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_executable(analyzer_tests tests/test_analyzer.cpp)
target_link_libraries(analyzer_tests PRIVATE codecraft_analyzer_core)
target_compile_options(analyzer_tests PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME analyzer_tests COMMAND analyzer_tests)
