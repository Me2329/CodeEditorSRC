# Plain make fallback for hosts without CMake. Produces the same binaries.
CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Iinclude
BUILD    := build

SOURCES  := src/lexer.cpp src/analyzer.cpp
OBJECTS  := $(SOURCES:%.cpp=$(BUILD)/%.o)

.PHONY: all test clean
all: $(BUILD)/codecraft-analyzer

$(BUILD)/codecraft-analyzer: $(OBJECTS) $(BUILD)/src/main.o
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -o $@ $^

$(BUILD)/analyzer_tests: $(OBJECTS) $(BUILD)/tests/test_analyzer.o
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -o $@ $^

$(BUILD)/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

test: $(BUILD)/analyzer_tests
	./$(BUILD)/analyzer_tests

clean:
	rm -rf $(BUILD)
