import json, collections

R = collections.OrderedDict()

def add(rid, label, category, monaco, ext, entry, probe, compile_, run, template, notes=""):
    R[rid] = {
        "id": rid, "label": label, "category": category, "monaco": monaco,
        "extension": ext, "entry": entry, "probe": probe,
        "compile": compile_, "run": run, "notes": notes, "template": template,
    }

# ---------------------------------------------------------------- native compiled
add("c", "C (GCC 13)", "native", "c", "c", "main.c", "gcc",
    ["gcc", "-O2", "-std=c17", "-Wall", "main.c", "-o", "main_bin", "-lm"],
    ["./main_bin"],
    '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from isolated C!\\n");\n    return 0;\n}\n')

add("cpp", "C++23 (G++ 13)", "native", "cpp", "cpp", "main.cpp", "g++",
    ["g++", "-O2", "-std=c++2b", "-Wall", "main.cpp", "-o", "main_bin"],
    ["./main_bin"],
    '#include <iostream>\n\nint main() {\n    std::cout << "Hello from isolated C++23!" << std::endl;\n    return 0;\n}\n')

add("rust", "Rust 1.78+", "native", "rust", "rs", "main.rs", "rustc",
    ["rustc", "-O", "main.rs", "-o", "main_bin"],
    ["./main_bin"],
    'fn main() {\n    println!("Hello from high-performance isolated Rust!");\n}\n')

add("go", "Go 1.22", "native", "go", "go", "main.go", "go",
    ["go", "build", "-o", "main_bin", "main.go"],
    ["./main_bin"],
    'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello from isolated Go!")\n}\n')

add("zig", "Zig 0.12", "native", "zig", "zig", "main.zig", "zig",
    ["zig", "build-exe", "-O", "ReleaseSafe", "--name", "main_bin", "main.zig"],
    ["./main_bin"],
    'const std = @import("std");\n\npub fn main() !void {\n    std.debug.print("Hello from isolated Zig!\\n", .{});\n}\n')

add("haskell", "Haskell (GHC 9.8)", "native", "haskell", "hs", "main.hs", "ghc",
    ["ghc", "-O2", "-o", "main_bin", "main.hs"],
    ["./main_bin"],
    'main :: IO ()\nmain = putStrLn "Hello from isolated Haskell!"\n')

add("d", "D (LDC / DMD)", "native", "d", "d", "main.d", "ldc2",
    ["ldc2", "-O2", "-of=main_bin", "main.d"],
    ["./main_bin"],
    'import std.stdio;\n\nvoid main() {\n    writeln("Hello from isolated D!");\n}\n')

add("fortran", "Fortran (gfortran)", "native", "plaintext", "f90", "main.f90", "gfortran",
    ["gfortran", "-O2", "-o", "main_bin", "main.f90"],
    ["./main_bin"],
    'program hello\n    print *, "Hello from isolated Fortran!"\nend program hello\n')

add("nim", "Nim 2.0", "native", "plaintext", "nim", "main.nim", "nim",
    ["nim", "c", "-d:release", "--nimcache:.nimcache", "-o:main_bin", "main.nim"],
    ["./main_bin"],
    'echo "Hello from isolated Nim!"\n')

add("assembly", "Assembly (NASM x86_64)", "native", "plaintext", "asm", "main.asm", "nasm",
    ["sh", "-c", "nasm -f elf64 main.asm -o main.o && ld main.o -o main_bin"],
    ["./main_bin"],
    'section .data\n    msg db "Hello from isolated NASM!", 10\n    len equ $ - msg\n\nsection .text\n    global _start\n\n_start:\n    mov rax, 1\n    mov rdi, 1\n    mov rsi, msg\n    mov rdx, len\n    syscall\n\n    mov rax, 60\n    xor rdi, rdi\n    syscall\n')

# ---------------------------------------------------------------- interpreted
add("python", "Python 3.12 (CPython)", "interpreted", "python", "py", "main.py", "python3",
    None, ["python3", "-u", "main.py"],
    'def main() -> None:\n    print("Hello from isolated Python!")\n\n\nif __name__ == "__main__":\n    main()\n')

add("pypy", "PyPy3 7.3 (JIT)", "interpreted", "python", "py", "main.py", "pypy3",
    None, ["pypy3", "-u", "main.py"],
    'print("Hello from isolated PyPy JIT!")\n')

add("ruby", "Ruby 3.3", "interpreted", "ruby", "rb", "main.rb", "ruby",
    None, ["ruby", "main.rb"],
    'puts "Hello from isolated Ruby!"\n')

add("php", "PHP 8.3 (JIT)", "interpreted", "php", "php", "main.php", "php",
    None, ["php", "main.php"],
    '<?php\n\necho "Hello from isolated PHP!" . PHP_EOL;\n')

add("perl", "Perl 5.38", "interpreted", "perl", "pl", "main.pl", "perl",
    None, ["perl", "main.pl"],
    'use strict;\nuse warnings;\n\nprint "Hello from isolated Perl!\\n";\n')

add("lua", "LuaJIT 2.1", "interpreted", "lua", "lua", "main.lua", "luajit",
    None, ["luajit", "main.lua"],
    'print("Hello from isolated LuaJIT!")\n')

add("r", "R 4.4", "interpreted", "r", "R", "main.R", "Rscript",
    None, ["Rscript", "main.R"],
    'cat("Hello from isolated R!\\n")\n')

add("julia", "Julia 1.10", "interpreted", "julia", "jl", "main.jl", "julia",
    None, ["julia", "main.jl"],
    'println("Hello from isolated Julia!")\n')

add("racket", "Racket 8.12", "interpreted", "scheme", "rkt", "main.rkt", "racket",
    None, ["racket", "main.rkt"],
    '#lang racket\n\n(displayln "Hello from isolated Racket!")\n')

add("erlang", "Erlang/OTP 26", "interpreted", "plaintext", "erl", "main.erl", "escript",
    None, ["escript", "main.erl"],
    'main(_Args) ->\n    io:format("Hello from isolated Erlang!~n").\n')

add("awk", "AWK", "interpreted", "plaintext", "awk", "main.awk", "awk",
    None, ["awk", "-f", "main.awk"],
    'BEGIN {\n    print "Hello from isolated AWK!"\n}\n')

# ---------------------------------------------------------------- managed VM
add("java", "Java 21 LTS (OpenJDK)", "managed", "java", "java", "Main.java", "java",
    None, ["java", "Main.java"],
    'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from isolated Java 21!");\n    }\n}\n',
    "Single-file source launch (JEP 330); no javac step required.")

add("csharp", "C# 12 (.NET 8.0)", "managed", "csharp", "cs", "main.cs", "mcs",
    ["mcs", "-out:main.exe", "main.cs"],
    ["mono", "main.exe"],
    'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello from isolated C#!");\n    }\n}\n')

add("fsharp", "F# 8.0", "managed", "fsharp", "fsx", "main.fsx", "dotnet",
    None, ["dotnet", "fsi", "--use:main.fsx", "--exec"],
    'printfn "Hello from isolated F#!"\n')

add("kotlin", "Kotlin 2.0", "managed", "kotlin", "kt", "main.kt", "kotlinc",
    ["kotlinc", "main.kt", "-include-runtime", "-d", "main.jar"],
    ["java", "-jar", "main.jar"],
    'fun main() {\n    println("Hello from isolated Kotlin!")\n}\n')

add("scala", "Scala 3.4", "managed", "scala", "scala", "main.scala", "scala",
    None, ["scala", "main.scala"],
    '@main def run(): Unit =\n  println("Hello from isolated Scala 3!")\n')

add("swift", "Swift 5.10", "managed", "swift", "swift", "main.swift", "swift",
    None, ["swift", "main.swift"],
    'print("Hello from isolated Swift!")\n')

add("dart", "Dart 3.3", "managed", "dart", "dart", "main.dart", "dart",
    None, ["dart", "run", "main.dart"],
    'void main() {\n  print(\'Hello from isolated Dart!\');\n}\n')

add("elixir", "Elixir 1.16 (BEAM)", "managed", "elixir", "exs", "main.exs", "elixir",
    None, ["elixir", "main.exs"],
    'IO.puts("Hello from isolated Elixir!")\n')

add("clojure", "Clojure 1.11", "managed", "clojure", "clj", "main.clj", "clojure",
    None, ["clojure", "-M", "main.clj"],
    '(println "Hello from isolated Clojure!")\n')

add("groovy", "Groovy 4.0", "managed", "groovy", "groovy", "main.groovy", "groovy",
    None, ["groovy", "main.groovy"],
    'println "Hello from isolated Groovy!"\n')

# ---------------------------------------------------------------- web & scripting
add("javascript", "JavaScript (Node 22 LTS)", "web", "javascript", "js", "main.js", "node",
    None, ["node", "--enable-source-maps", "main.js"],
    'console.log("Hello from isolated Node.js 22!");\n')

add("typescript", "TypeScript 5.4 (Deno)", "web", "typescript", "ts", "main.ts", "deno",
    None, ["deno", "run", "--quiet", "main.ts"],
    'const greeting: string = "Hello from isolated Deno TypeScript!";\nconsole.log(greeting);\n')

add("bun", "Bun 1.1", "web", "typescript", "ts", "main.ts", "bun",
    None, ["bun", "run", "main.ts"],
    'const greeting: string = "Hello from isolated Bun!";\nconsole.log(greeting);\n')

add("bash", "Bash 5.2", "web", "shell", "sh", "main.sh", "bash",
    None, ["bash", "main.sh"],
    '#!/usr/bin/env bash\nset -euo pipefail\n\necho "Hello from isolated Bash!"\n')

add("zsh", "Zsh 5.9", "web", "shell", "zsh", "main.zsh", "zsh",
    None, ["zsh", "main.zsh"],
    'echo "Hello from isolated Zsh!"\n')

add("powershell", "PowerShell Core 7.4", "web", "powershell", "ps1", "main.ps1", "pwsh",
    None, ["pwsh", "-NoProfile", "-File", "main.ps1"],
    'Write-Output "Hello from isolated PowerShell!"\n')

add("sql", "SQL (SQLite 3)", "web", "sql", "sql", "main.sql", "sqlite3",
    None, ["sh", "-c", "sqlite3 -batch -header -column sandbox.db < main.sql"],
    'CREATE TABLE runs (id INTEGER PRIMARY KEY, engine TEXT, ok INTEGER);\n\nINSERT INTO runs (engine, ok) VALUES (\'sqlite3\', 1), (\'codecraft\', 1);\n\nSELECT id, engine, ok FROM runs;\n')

add("jq", "jq (JSON processor)", "web", "plaintext", "jq", "main.jq", "jq",
    None, ["sh", "-c", "echo '{\"engine\":\"codecraft\",\"tier\":\"sandboxed\"}' | jq -f main.jq"],
    '{ engine: .engine, message: "Hello from isolated jq!" }\n')

add("wasm", "WebAssembly (Wasmtime)", "web", "plaintext", "wat", "main.wat", "wasmtime",
    None, ["wasmtime", "main.wat"],
    '(module\n  (func (export "_start")))\n')

add("html", "HTML5 / CSS3 / JS (Live Preview)", "web", "html", "html", "index.html", None,
    None, None,
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>CodeCraft Preview</title>\n    <style>\n      body { background: #0b0e14; color: #e2e8f0; font-family: system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0; }\n      h1 { background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899); -webkit-background-clip: text; color: transparent; }\n    </style>\n  </head>\n  <body>\n    <h1>Hello from the live web preview!</h1>\n  </body>\n</html>\n',
    "Rendered client-side in a sandboxed iframe; never dispatched to the execution backend.")


# Runtimes whose VM reserves a huge virtual address space up-front (JVM, Go, V8,
# BEAM, CoreCLR). RLIMIT_AS would kill them at startup, so their memory ceiling is
# enforced by cgroups v2 + wall-clock timeout instead of an address-space rlimit.
RELAXED_AS = {
    "go", "java", "kotlin", "scala", "groovy", "clojure", "csharp", "fsharp",
    "swift", "dart", "julia", "erlang", "elixir", "javascript", "typescript",
    "bun", "wasm", "haskell", "racket",
}
for _rid, _rt in R.items():
    _rt["as_limit"] = "relaxed" if _rid in RELAXED_AS else "strict"

print(json.dumps({"version": 1, "runtimes": R}, indent=2))
