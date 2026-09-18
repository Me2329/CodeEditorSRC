"""The task catalogue: one idea, written correctly in several languages.

Every implementation here is written out rather than generated, because the
one thing worse than too little fine-tuning data is data that teaches a model
code that does not work. A model has no way to tell a plausible answer from a
correct one, and neither will its output.

Each task carries several phrasings of the same request. That is not padding:
an instruction-tuned model has to learn that "reverse a string", "how do I
reverse a string" and "write a function to reverse text" are one intent, and
the only way it learns that is by seeing them map to one answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Task:
    """One idea, its phrasings, and how it is written in each language."""

    name: str
    #: How a person might ask for it. The first is the canonical form.
    phrasings: tuple[str, ...]
    #: Language id (as the editor names it) to implementation.
    code: dict[str, str] = field(default_factory=dict)
    #: One sentence, for the "explain this" direction.
    explanation: str = ""


def task(name: str, phrasings: list[str], explanation: str, **code: str) -> Task:
    return Task(
        name=name,
        phrasings=tuple(phrasings),
        code={language: body.strip("\n") for language, body in code.items()},
        explanation=explanation,
    )


TASKS: list[Task] = [
    task(
        "reverse a string",
        [
            "reverse a string",
            "how do I reverse a string",
            "write a function that reverses text",
            "reverse the characters in a string",
            "function to flip a string backwards",
        ],
        "It returns the characters of the input in the opposite order.",
        python='''
def reverse(text: str) -> str:
    return text[::-1]
''',
        javascript='''
function reverse(text) {
  return [...text].reverse().join("");
}
''',
        typescript='''
export function reverse(text: string): string {
  return [...text].reverse().join("");
}
''',
        rust='''
fn reverse(text: &str) -> String {
    text.chars().rev().collect()
}
''',
        go='''
func Reverse(text string) string {
	runes := []rune(text)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
''',
        c='''
void reverse(char *text) {
    size_t length = strlen(text);
    for (size_t i = 0; i < length / 2; i++) {
        char held = text[i];
        text[i] = text[length - 1 - i];
        text[length - 1 - i] = held;
    }
}
''',
        cpp='''
std::string reverse(std::string text) {
    std::reverse(text.begin(), text.end());
    return text;
}
''',
        java='''
static String reverse(String text) {
    return new StringBuilder(text).reverse().toString();
}
''',
        ruby='''
def reverse(text)
  text.reverse
end
''',
        shell='''
reverse() {
    printf '%s' "$1" | rev
}
''',
        lua='''
function reverse(text)
  return string.reverse(text)
end
''',
    ),
    task(
        "sum a list of numbers",
        [
            "sum the numbers in a list",
            "add up every number in an array",
            "total a list of integers",
            "how do I add all the values in a list",
            "write a function that returns the sum of a list",
        ],
        "It adds every element together and returns the total.",
        python='''
def total(values: list[int]) -> int:
    return sum(values)
''',
        javascript='''
function total(values) {
  return values.reduce((sum, value) => sum + value, 0);
}
''',
        typescript='''
export function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
''',
        rust='''
fn total(values: &[i64]) -> i64 {
    values.iter().sum()
}
''',
        go='''
func Total(values []int) int {
	sum := 0
	for _, value := range values {
		sum += value
	}
	return sum
}
''',
        c='''
long total(const int *values, size_t count) {
    long sum = 0;
    for (size_t i = 0; i < count; i++) {
        sum += values[i];
    }
    return sum;
}
''',
        cpp='''
long total(const std::vector<int> &values) {
    return std::accumulate(values.begin(), values.end(), 0L);
}
''',
        java='''
static long total(int[] values) {
    long sum = 0;
    for (int value : values) {
        sum += value;
    }
    return sum;
}
''',
        ruby='''
def total(values)
  values.sum
end
''',
        shell='''
total() {
    awk '{ sum += $1 } END { print sum + 0 }'
}
''',
        lua='''
function total(values)
  local sum = 0
  for _, value in ipairs(values) do
    sum = sum + value
  end
  return sum
end
''',
        sql='''
SELECT SUM(value) AS total FROM measurements;
''',
    ),
    task(
        "check whether a string is a palindrome",
        [
            "check whether a string is a palindrome",
            "is this word a palindrome",
            "write a palindrome checker",
            "test if text reads the same backwards",
            "function that detects palindromes ignoring punctuation",
        ],
        "It strips anything that is not a letter or digit, lowercases the rest, "
        "and compares the result with its own reverse.",
        python='''
def is_palindrome(text: str) -> bool:
    cleaned = "".join(c.lower() for c in text if c.isalnum())
    return cleaned == cleaned[::-1]
''',
        javascript='''
function isPalindrome(text) {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === [...cleaned].reverse().join("");
}
''',
        typescript='''
export function isPalindrome(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === [...cleaned].reverse().join("");
}
''',
        rust='''
fn is_palindrome(text: &str) -> bool {
    let cleaned: Vec<char> = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    cleaned.iter().eq(cleaned.iter().rev())
}
''',
        go='''
func IsPalindrome(text string) bool {
	var cleaned []rune
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			cleaned = append(cleaned, r)
		}
	}
	for i, j := 0, len(cleaned)-1; i < j; i, j = i+1, j-1 {
		if cleaned[i] != cleaned[j] {
			return false
		}
	}
	return true
}
''',
        java='''
static boolean isPalindrome(String text) {
    String cleaned = text.toLowerCase().replaceAll("[^a-z0-9]", "");
    return cleaned.equals(new StringBuilder(cleaned).reverse().toString());
}
''',
        ruby='''
def palindrome?(text)
  cleaned = text.downcase.gsub(/[^a-z0-9]/, "")
  cleaned == cleaned.reverse
end
''',
        cpp='''
bool is_palindrome(const std::string &text) {
    std::string cleaned;
    for (unsigned char c : text) {
        if (std::isalnum(c)) cleaned += static_cast<char>(std::tolower(c));
    }
    return std::equal(cleaned.begin(), cleaned.begin() + cleaned.size() / 2, cleaned.rbegin());
}
''',
    ),
    task(
        "read a file into a list of lines",
        [
            "read a file into a list of lines",
            "how do I read every line of a file",
            "load a text file line by line",
            "open a file and return its lines",
            "read a file without the trailing newlines",
        ],
        "It opens the file as UTF-8 text and returns its lines without the line "
        "endings.",
        python='''
def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as handle:
        return handle.read().splitlines()
''',
        javascript='''
import { readFileSync } from "node:fs";

function readLines(path) {
  return readFileSync(path, "utf8").split(/\\r?\\n/);
}
''',
        typescript='''
import { readFileSync } from "node:fs";

export function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split(/\\r?\\n/);
}
''',
        rust='''
use std::fs;
use std::io;

fn read_lines(path: &str) -> io::Result<Vec<String>> {
    Ok(fs::read_to_string(path)?.lines().map(String::from).collect())
}
''',
        go='''
func ReadLines(path string) ([]string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return strings.Split(strings.TrimRight(string(body), "\\n"), "\\n"), nil
}
''',
        ruby='''
def read_lines(path)
  File.readlines(path, chomp: true)
end
''',
        shell='''
read_lines() {
    mapfile -t lines < "$1"
    printf '%s\\n' "${lines[@]}"
}
''',
    ),
    task(
        "find the largest number in a list",
        [
            "find the largest number in a list",
            "get the maximum value of an array",
            "what is the biggest element",
            "write a function returning the max of a list",
            "find the highest value without using max",
        ],
        "It walks the list once, keeping whichever value seen so far is largest.",
        python='''
def largest(values: list[int]) -> int:
    if not values:
        raise ValueError("no values to compare")
    biggest = values[0]
    for value in values[1:]:
        if value > biggest:
            biggest = value
    return biggest
''',
        javascript='''
function largest(values) {
  if (values.length === 0) throw new Error("no values to compare");
  return values.reduce((big, value) => (value > big ? value : big), values[0]);
}
''',
        typescript='''
export function largest(values: readonly number[]): number {
  if (values.length === 0) throw new Error("no values to compare");
  return values.reduce((big, value) => (value > big ? value : big), values[0]!);
}
''',
        rust='''
fn largest(values: &[i64]) -> Option<i64> {
    values.iter().copied().max()
}
''',
        go='''
func Largest(values []int) (int, error) {
	if len(values) == 0 {
		return 0, errors.New("no values to compare")
	}
	biggest := values[0]
	for _, value := range values[1:] {
		if value > biggest {
			biggest = value
		}
	}
	return biggest, nil
}
''',
        java='''
static int largest(int[] values) {
    if (values.length == 0) throw new IllegalArgumentException("no values to compare");
    int biggest = values[0];
    for (int value : values) {
        if (value > biggest) biggest = value;
    }
    return biggest;
}
''',
        c='''
int largest(const int *values, size_t count) {
    int biggest = values[0];
    for (size_t i = 1; i < count; i++) {
        if (values[i] > biggest) biggest = values[i];
    }
    return biggest;
}
''',
        ruby='''
def largest(values)
  raise ArgumentError, "no values to compare" if values.empty?
  values.max
end
''',
        sql='''
SELECT MAX(value) AS largest FROM measurements;
''',
    ),
    task(
        "remove duplicates from a list",
        [
            "remove duplicates from a list",
            "deduplicate an array keeping the order",
            "how do I get the unique values",
            "drop repeated elements",
            "unique items without losing the original order",
        ],
        "It keeps the first appearance of each value and drops the rest, so the "
        "original order survives.",
        python='''
def unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    kept: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            kept.append(value)
    return kept
''',
        javascript='''
function unique(values) {
  return [...new Set(values)];
}
''',
        typescript='''
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
''',
        rust='''
use std::collections::HashSet;

fn unique(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values.iter().filter(|v| seen.insert((*v).clone())).cloned().collect()
}
''',
        go='''
func Unique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if _, found := seen[value]; found {
			continue
		}
		seen[value] = struct{}{}
		kept = append(kept, value)
	}
	return kept
}
''',
        ruby='''
def unique(values)
  values.uniq
end
''',
        sql='''
SELECT DISTINCT name FROM people ORDER BY name;
''',
    ),
    task(
        "count how often each word appears",
        [
            "count how often each word appears",
            "word frequency count",
            "build a histogram of words in a string",
            "tally the words in some text",
            "which word appears most often",
        ],
        "It lowercases the text, splits it on whitespace, and counts each word "
        "into a map.",
        python='''
from collections import Counter


def word_counts(text: str) -> dict[str, int]:
    return dict(Counter(text.lower().split()))
''',
        javascript='''
function wordCounts(text) {
  const counts = new Map();
  for (const word of text.toLowerCase().split(/\\s+/).filter(Boolean)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}
''',
        typescript='''
export function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().split(/\\s+/).filter(Boolean)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}
''',
        rust='''
use std::collections::HashMap;

fn word_counts(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in text.to_lowercase().split_whitespace() {
        *counts.entry(word.to_string()).or_insert(0) += 1;
    }
    counts
}
''',
        go='''
func WordCounts(text string) map[string]int {
	counts := map[string]int{}
	for _, word := range strings.Fields(strings.ToLower(text)) {
		counts[word]++
	}
	return counts
}
''',
        ruby='''
def word_counts(text)
  text.downcase.split.tally
end
''',
        shell='''
word_counts() {
    tr 'A-Z' 'a-z' | tr -s '[:space:]' '\\n' | sort | uniq -c | sort -rn
}
''',
        sql='''
SELECT word, COUNT(*) AS occurrences
FROM words
GROUP BY word
ORDER BY occurrences DESC;
''',
    ),
    task(
        "binary search a sorted list",
        [
            "binary search a sorted list",
            "find an item in a sorted array quickly",
            "implement binary search",
            "search a sorted list in log n",
            "where is this value in the sorted array",
        ],
        "It halves the search range each step, so it finds the value in about "
        "log2(n) comparisons. The list has to be sorted already.",
        python='''
def binary_search(values: list[int], wanted: int) -> int:
    low, high = 0, len(values) - 1
    while low <= high:
        middle = (low + high) // 2
        if values[middle] == wanted:
            return middle
        if values[middle] < wanted:
            low = middle + 1
        else:
            high = middle - 1
    return -1
''',
        javascript='''
function binarySearch(values, wanted) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle] === wanted) return middle;
    if (values[middle] < wanted) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}
''',
        typescript='''
export function binarySearch(values: readonly number[], wanted: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const seen = values[middle]!;
    if (seen === wanted) return middle;
    if (seen < wanted) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}
''',
        rust='''
fn binary_search(values: &[i64], wanted: i64) -> Option<usize> {
    let (mut low, mut high) = (0usize, values.len());
    while low < high {
        let middle = low + (high - low) / 2;
        match values[middle].cmp(&wanted) {
            std::cmp::Ordering::Equal => return Some(middle),
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
        }
    }
    None
}
''',
        go='''
func BinarySearch(values []int, wanted int) int {
	low, high := 0, len(values)-1
	for low <= high {
		middle := low + (high-low)/2
		switch {
		case values[middle] == wanted:
			return middle
		case values[middle] < wanted:
			low = middle + 1
		default:
			high = middle - 1
		}
	}
	return -1
}
''',
        java='''
static int binarySearch(int[] values, int wanted) {
    int low = 0, high = values.length - 1;
    while (low <= high) {
        int middle = low + (high - low) / 2;
        if (values[middle] == wanted) return middle;
        if (values[middle] < wanted) low = middle + 1;
        else high = middle - 1;
    }
    return -1;
}
''',
        c='''
int binary_search(const int *values, size_t count, int wanted) {
    size_t low = 0, high = count;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (values[middle] == wanted) return (int)middle;
        if (values[middle] < wanted) low = middle + 1;
        else high = middle;
    }
    return -1;
}
''',
    ),
]

TASKS += [
    task(
        "fizzbuzz",
        [
            "write fizzbuzz",
            "print fizzbuzz up to n",
            "the fizzbuzz problem",
            "multiples of three print fizz, five print buzz",
            "implement fizzbuzz",
        ],
        "It counts to n, printing Fizz for multiples of 3, Buzz for multiples of "
        "5, FizzBuzz for both, and the number otherwise.",
        python="""
def fizzbuzz(limit: int) -> None:
    for number in range(1, limit + 1):
        if number % 15 == 0:
            print("FizzBuzz")
        elif number % 3 == 0:
            print("Fizz")
        elif number % 5 == 0:
            print("Buzz")
        else:
            print(number)
""",
        javascript="""
function fizzbuzz(limit) {
  for (let number = 1; number <= limit; number += 1) {
    if (number % 15 === 0) console.log("FizzBuzz");
    else if (number % 3 === 0) console.log("Fizz");
    else if (number % 5 === 0) console.log("Buzz");
    else console.log(number);
  }
}
""",
        rust="""
fn fizzbuzz(limit: u32) {
    for number in 1..=limit {
        match (number % 3, number % 5) {
            (0, 0) => println!("FizzBuzz"),
            (0, _) => println!("Fizz"),
            (_, 0) => println!("Buzz"),
            _ => println!("{number}"),
        }
    }
}
""",
        go="""
func FizzBuzz(limit int) {
	for number := 1; number <= limit; number++ {
		switch {
		case number%15 == 0:
			fmt.Println("FizzBuzz")
		case number%3 == 0:
			fmt.Println("Fizz")
		case number%5 == 0:
			fmt.Println("Buzz")
		default:
			fmt.Println(number)
		}
	}
}
""",
        java="""
static void fizzbuzz(int limit) {
    for (int number = 1; number <= limit; number++) {
        if (number % 15 == 0) System.out.println("FizzBuzz");
        else if (number % 3 == 0) System.out.println("Fizz");
        else if (number % 5 == 0) System.out.println("Buzz");
        else System.out.println(number);
    }
}
""",
        c="""
void fizzbuzz(int limit) {
    for (int number = 1; number <= limit; number++) {
        if (number % 15 == 0) puts("FizzBuzz");
        else if (number % 3 == 0) puts("Fizz");
        else if (number % 5 == 0) puts("Buzz");
        else printf("%d\\n", number);
    }
}
""",
        ruby="""
def fizzbuzz(limit)
  (1..limit).each do |number|
    if (number % 15).zero? then puts "FizzBuzz"
    elsif (number % 3).zero? then puts "Fizz"
    elsif (number % 5).zero? then puts "Buzz"
    else puts number
    end
  end
end
""",
        shell="""
fizzbuzz() {
    for ((number = 1; number <= $1; number++)); do
        if ((number % 15 == 0)); then echo FizzBuzz
        elif ((number % 3 == 0)); then echo Fizz
        elif ((number % 5 == 0)); then echo Buzz
        else echo "$number"
        fi
    done
}
""",
    ),
    task(
        "compute a factorial",
        [
            "compute a factorial",
            "write a factorial function",
            "n factorial",
            "multiply every number from 1 to n",
            "factorial without recursion",
        ],
        "It multiplies every integer from 1 to n. Written as a loop, so a large "
        "n does not exhaust the call stack.",
        python="""
def factorial(number: int) -> int:
    if number < 0:
        raise ValueError("factorial is not defined for negative numbers")
    result = 1
    for step in range(2, number + 1):
        result *= step
    return result
""",
        javascript="""
function factorial(number) {
  if (number < 0) throw new RangeError("factorial is not defined for negatives");
  let result = 1n;
  for (let step = 2n; step <= BigInt(number); step += 1n) result *= step;
  return result;
}
""",
        rust="""
fn factorial(number: u64) -> u128 {
    (1..=u128::from(number)).product()
}
""",
        go="""
func Factorial(number int) *big.Int {
	result := big.NewInt(1)
	for step := 2; step <= number; step++ {
		result.Mul(result, big.NewInt(int64(step)))
	}
	return result
}
""",
        java="""
static BigInteger factorial(int number) {
    BigInteger result = BigInteger.ONE;
    for (int step = 2; step <= number; step++) {
        result = result.multiply(BigInteger.valueOf(step));
    }
    return result;
}
""",
        ruby="""
def factorial(number)
  (1..number).reduce(1, :*)
end
""",
        lua="""
function factorial(number)
  local result = 1
  for step = 2, number do
    result = result * step
  end
  return result
end
""",
    ),
    task(
        "swap two variables",
        [
            "swap two variables",
            "exchange the values of two variables",
            "how do I swap a and b",
            "swap without a temporary variable",
            "switch two values around",
        ],
        "It exchanges the two values. Most modern languages can do it in one "
        "statement without a temporary.",
        python="""
a, b = b, a
""",
        javascript="""
[a, b] = [b, a];
""",
        rust="""
std::mem::swap(&mut a, &mut b);
""",
        go="""
a, b = b, a
""",
        java="""
int held = a;
a = b;
b = held;
""",
        c="""
int held = a;
a = b;
b = held;
""",
        ruby="""
a, b = b, a
""",
        lua="""
a, b = b, a
""",
    ),
    task(
        "sort a list of strings",
        [
            "sort a list of strings",
            "alphabetise an array",
            "sort names in order",
            "how do I sort strings case-insensitively",
            "put a list in alphabetical order",
        ],
        "It orders the values alphabetically, ignoring case so that "
        "\"Apple\" and \"apple\" sort together.",
        python="""
def sorted_names(names: list[str]) -> list[str]:
    return sorted(names, key=str.lower)
""",
        javascript="""
function sortedNames(names) {
  return [...names].sort((left, right) => left.localeCompare(right));
}
""",
        typescript="""
export function sortedNames(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}
""",
        rust="""
fn sorted_names(names: &[String]) -> Vec<String> {
    let mut sorted = names.to_vec();
    sorted.sort_by_key(|name| name.to_lowercase());
    sorted
}
""",
        go="""
func SortedNames(names []string) []string {
	sorted := append([]string(nil), names...)
	sort.Slice(sorted, func(i, j int) bool {
		return strings.ToLower(sorted[i]) < strings.ToLower(sorted[j])
	})
	return sorted
}
""",
        java="""
static List<String> sortedNames(List<String> names) {
    List<String> sorted = new ArrayList<>(names);
    sorted.sort(String.CASE_INSENSITIVE_ORDER);
    return sorted;
}
""",
        ruby="""
def sorted_names(names)
  names.sort_by(&:downcase)
end
""",
        shell="""
sorted_names() {
    sort -f
}
""",
        sql="""
SELECT name FROM people ORDER BY LOWER(name);
""",
    ),
    task(
        "check whether a number is prime",
        [
            "check whether a number is prime",
            "write a primality test",
            "is this number prime",
            "test for primes efficiently",
            "prime checker without a sieve",
        ],
        "It rules out the easy cases, then tries divisors up to the square root "
        "of n — past that, any factor would already have been found.",
        python="""
def is_prime(number: int) -> bool:
    if number < 2:
        return False
    if number % 2 == 0:
        return number == 2
    divisor = 3
    while divisor * divisor <= number:
        if number % divisor == 0:
            return False
        divisor += 2
    return True
""",
        javascript="""
function isPrime(number) {
  if (number < 2) return false;
  if (number % 2 === 0) return number === 2;
  for (let divisor = 3; divisor * divisor <= number; divisor += 2) {
    if (number % divisor === 0) return false;
  }
  return true;
}
""",
        rust="""
fn is_prime(number: u64) -> bool {
    if number < 2 {
        return false;
    }
    if number % 2 == 0 {
        return number == 2;
    }
    let mut divisor = 3;
    while divisor * divisor <= number {
        if number % divisor == 0 {
            return false;
        }
        divisor += 2;
    }
    true
}
""",
        go="""
func IsPrime(number int) bool {
	if number < 2 {
		return false
	}
	if number%2 == 0 {
		return number == 2
	}
	for divisor := 3; divisor*divisor <= number; divisor += 2 {
		if number%divisor == 0 {
			return false
		}
	}
	return true
}
""",
        java="""
static boolean isPrime(int number) {
    if (number < 2) return false;
    if (number % 2 == 0) return number == 2;
    for (int divisor = 3; (long) divisor * divisor <= number; divisor += 2) {
        if (number % divisor == 0) return false;
    }
    return true;
}
""",
        c="""
bool is_prime(long number) {
    if (number < 2) return false;
    if (number % 2 == 0) return number == 2;
    for (long divisor = 3; divisor * divisor <= number; divisor += 2) {
        if (number % divisor == 0) return false;
    }
    return true;
}
""",
        ruby="""
def prime?(number)
  return false if number < 2
  return number == 2 if number.even?
  (3..Integer.sqrt(number)).step(2).none? { |d| (number % d).zero? }
end
""",
    ),
    task(
        "write to a file",
        [
            "write text to a file",
            "how do I save a string to disk",
            "create a file and write to it",
            "overwrite a file with new contents",
            "write a file safely as utf-8",
        ],
        "It opens the path for writing, which truncates anything already there, "
        "and writes the text as UTF-8.",
        python="""
def write_text(path: str, body: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(body)
""",
        javascript="""
import { writeFileSync } from "node:fs";

function writeText(path, body) {
  writeFileSync(path, body, "utf8");
}
""",
        typescript="""
import { writeFileSync } from "node:fs";

export function writeText(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
}
""",
        rust="""
use std::fs;
use std::io;

fn write_text(path: &str, body: &str) -> io::Result<()> {
    fs::write(path, body)
}
""",
        go="""
func WriteText(path, body string) error {
	return os.WriteFile(path, []byte(body), 0o644)
}
""",
        ruby="""
def write_text(path, body)
  File.write(path, body)
end
""",
        shell="""
write_text() {
    printf '%s' "$2" > "$1"
}
""",
    ),
    task(
        "parse JSON",
        [
            "parse a JSON string",
            "read JSON into an object",
            "how do I decode JSON",
            "turn JSON text into data",
            "parse JSON and handle a bad document",
        ],
        "It parses the text into native data, and reports a malformed document "
        "rather than returning something half-built.",
        python="""
import json


def parse(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"not valid JSON: {error}") from error
""",
        javascript="""
function parse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${error.message}`);
  }
}
""",
        typescript="""
export function parse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
}
""",
        rust="""
fn parse(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(text).map_err(|error| format!("not valid JSON: {error}"))
}
""",
        go="""
func Parse(text string) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil, fmt.Errorf("not valid JSON: %w", err)
	}
	return payload, nil
}
""",
        ruby="""
require "json"

def parse(text)
  JSON.parse(text)
rescue JSON::ParserError => error
  raise ArgumentError, "not valid JSON: #{error.message}"
end
""",
    ),
    task(
        "make an HTTP GET request",
        [
            "make an HTTP GET request",
            "fetch a url and read the body",
            "how do I call an API",
            "download a page over http",
            "get json from an endpoint",
        ],
        "It requests the URL, checks the status before trusting the body, and "
        "returns the text.",
        python="""
import urllib.request


def fetch(url: str, timeout: float = 10.0) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} answered {response.status}")
        return response.read().decode("utf-8")
""",
        javascript="""
async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}
""",
        typescript="""
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}
""",
        go="""
func Fetch(url string) (string, error) {
	response, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %d", url, response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	return string(body), err
}
""",
        ruby="""
require "net/http"

def fetch(url)
  response = Net::HTTP.get_response(URI(url))
  raise "#{url} answered #{response.code}" unless response.is_a?(Net::HTTPSuccess)
  response.body
end
""",
        shell="""
fetch() {
    curl --fail --silent --show-error "$1"
}
""",
    ),
    task(
        "count the lines in a file",
        [
            "count the lines in a file",
            "how many lines does this file have",
            "line count without loading the whole file",
            "count lines efficiently",
            "wc -l in code",
        ],
        "It reads the file a chunk at a time and counts newlines, so a file "
        "larger than memory still works.",
        python="""
def count_lines(path: str) -> int:
    lines = 0
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            lines += chunk.count(b"\\n")
    return lines
""",
        rust="""
use std::fs::File;
use std::io::{self, BufRead, BufReader};

fn count_lines(path: &str) -> io::Result<usize> {
    Ok(BufReader::new(File::open(path)?).lines().count())
}
""",
        go="""
func CountLines(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	lines := 0
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lines++
	}
	return lines, scanner.Err()
}
""",
        ruby="""
def count_lines(path)
  File.foreach(path).count
end
""",
        shell="""
count_lines() {
    wc -l < "$1"
}
""",
    ),
    task(
        "convert a string to a number safely",
        [
            "convert a string to a number safely",
            "parse an integer without crashing",
            "how do I turn text into a number",
            "string to int with a fallback",
            "parse a number and handle bad input",
        ],
        "It converts the text, and returns the fallback rather than raising when "
        "the text is not a number.",
        python="""
def to_int(text: str, fallback: int = 0) -> int:
    try:
        return int(text.strip())
    except (TypeError, ValueError):
        return fallback
""",
        javascript="""
function toInt(text, fallback = 0) {
  const parsed = Number.parseInt(String(text).trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
""",
        typescript="""
export function toInt(text: string, fallback = 0): number {
  const parsed = Number.parseInt(text.trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
""",
        rust="""
fn to_int(text: &str, fallback: i64) -> i64 {
    text.trim().parse().unwrap_or(fallback)
}
""",
        go="""
func ToInt(text string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		return fallback
	}
	return parsed
}
""",
        java="""
static int toInt(String text, int fallback) {
    try {
        return Integer.parseInt(text.trim());
    } catch (NumberFormatException error) {
        return fallback;
    }
}
""",
        ruby="""
def to_int(text, fallback = 0)
  Integer(text.to_s.strip)
rescue ArgumentError, TypeError
  fallback
end
""",
    ),
    task(
        "flatten a nested list",
        [
            "flatten a nested list",
            "turn a list of lists into one list",
            "how do I flatten an array",
            "flatten arbitrarily deep nesting",
            "collapse nested arrays into a flat one",
        ],
        "It walks the structure and yields every non-list element, so nesting of "
        "any depth comes out flat.",
        python="""
def flatten(values: list) -> list:
    flat = []
    for value in values:
        if isinstance(value, list):
            flat.extend(flatten(value))
        else:
            flat.append(value)
    return flat
""",
        javascript="""
function flatten(values) {
  return values.flat(Infinity);
}
""",
        typescript="""
export function flatten<T>(values: unknown[]): T[] {
  return values.flat(Infinity) as T[];
}
""",
        ruby="""
def flatten(values)
  values.flatten
end
""",
        rust="""
fn flatten(values: Vec<Vec<i64>>) -> Vec<i64> {
    values.into_iter().flatten().collect()
}
""",
    ),
    task(
        "measure how long a function takes",
        [
            "measure how long a function takes",
            "time a piece of code",
            "how do I benchmark a function",
            "print the elapsed time of an operation",
            "measure execution time accurately",
        ],
        "It reads a monotonic clock either side of the call. A monotonic clock "
        "rather than the wall clock, which can jump backwards.",
        python="""
import time


def timed(work, *args):
    started = time.perf_counter()
    result = work(*args)
    print(f"{work.__name__} took {(time.perf_counter() - started) * 1000:.1f}ms")
    return result
""",
        javascript="""
function timed(work, ...args) {
  const started = performance.now();
  const result = work(...args);
  console.log(`${work.name} took ${(performance.now() - started).toFixed(1)}ms`);
  return result;
}
""",
        rust="""
use std::time::Instant;

fn timed<T>(label: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = work();
    println!("{label} took {:?}", started.elapsed());
    result
}
""",
        go="""
func Timed(label string, work func()) {
	started := time.Now()
	work()
	fmt.Printf("%s took %s\\n", label, time.Since(started))
}
""",
        shell="""
timed() {
    local started=$SECONDS
    "$@"
    echo "took $((SECONDS - started))s"
}
""",
    ),
]

TASKS += [
    task(
        "debounce a function",
        [
            "debounce a function",
            "only run this after the user stops typing",
            "how do I debounce an event handler",
            "delay a callback until input settles",
            "stop a handler firing on every keystroke",
        ],
        "It delays the call until the events stop arriving for the given wait, "
        "so a burst of input produces one call instead of dozens.",
        javascript="""
function debounce(work, wait = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => work(...args), wait);
  };
}
""",
        typescript="""
export function debounce<A extends unknown[]>(
  work: (...args: A) => void,
  wait = 200,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => work(...args), wait);
  };
}
""",
        python="""
import threading


def debounce(wait: float):
    def decorate(work):
        timer: threading.Timer | None = None

        def call(*args, **kwargs):
            nonlocal timer
            if timer is not None:
                timer.cancel()
            timer = threading.Timer(wait, work, args, kwargs)
            timer.start()

        return call

    return decorate
""",
    ),
    task(
        "retry an operation that might fail",
        [
            "retry an operation that might fail",
            "retry with backoff",
            "how do I retry a failing request",
            "try something a few times before giving up",
            "exponential backoff retry loop",
        ],
        "It tries again after a wait that doubles each time, and re-raises the "
        "last failure once the attempts run out rather than returning quietly.",
        python="""
import time


def retry(work, attempts: int = 4, wait: float = 1.0):
    for attempt in range(1, attempts + 1):
        try:
            return work()
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(wait * 2 ** (attempt - 1))
""",
        javascript="""
async function retry(work, attempts = 4, wait = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resume) => setTimeout(resume, wait * 2 ** (attempt - 1)));
    }
  }
}
""",
        typescript="""
export async function retry<T>(
  work: () => Promise<T>,
  attempts = 4,
  wait = 1000,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resume) => setTimeout(resume, wait * 2 ** (attempt - 1)));
    }
  }
  throw new Error("unreachable");
}
""",
        go="""
func Retry(work func() error, attempts int, wait time.Duration) error {
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err = work(); err == nil {
			return nil
		}
		if attempt < attempts {
			time.Sleep(wait << (attempt - 1))
		}
	}
	return err
}
""",
        shell="""
retry() {
    local attempts=$1; shift
    local wait=1
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        "$@" && return 0
        ((attempt < attempts)) && sleep "$wait" && ((wait *= 2))
    done
    return 1
}
""",
    ),
    task(
        "group a list of records by a field",
        [
            "group a list of records by a field",
            "group items by category",
            "how do I bucket objects by a key",
            "turn a list into a map keyed by a property",
            "group by, in code rather than sql",
        ],
        "It walks the records once, appending each into the bucket named by its "
        "key, which is a single pass rather than one scan per group.",
        python="""
from collections import defaultdict


def group_by(records: list[dict], field: str) -> dict:
    grouped = defaultdict(list)
    for record in records:
        grouped[record[field]].append(record)
    return dict(grouped)
""",
        javascript="""
function groupBy(records, field) {
  const grouped = new Map();
  for (const record of records) {
    const key = record[field];
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  return grouped;
}
""",
        typescript="""
export function groupBy<T, K extends keyof T>(
  records: readonly T[],
  field: K,
): Map<T[K], T[]> {
  const grouped = new Map<T[K], T[]>();
  for (const record of records) {
    const key = record[field];
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }
  return grouped;
}
""",
        go="""
func GroupBy(records []Record, key func(Record) string) map[string][]Record {
	grouped := map[string][]Record{}
	for _, record := range records {
		name := key(record)
		grouped[name] = append(grouped[name], record)
	}
	return grouped
}
""",
        ruby="""
def group_by(records, field)
  records.group_by { |record| record[field] }
end
""",
        sql="""
SELECT category, COUNT(*) AS items
FROM products
GROUP BY category
ORDER BY items DESC;
""",
    ),
    task(
        "strip whitespace from the ends of a string",
        [
            "strip whitespace from the ends of a string",
            "trim a string",
            "how do I remove leading and trailing spaces",
            "clean up whitespace around input",
            "trim without touching the middle",
        ],
        "It removes whitespace from both ends and leaves the inside alone.",
        python="""
cleaned = text.strip()
""",
        javascript="""
const cleaned = text.trim();
""",
        typescript="""
const cleaned: string = text.trim();
""",
        rust="""
let cleaned = text.trim();
""",
        go="""
cleaned := strings.TrimSpace(text)
""",
        java="""
String cleaned = text.strip();
""",
        ruby="""
cleaned = text.strip
""",
        lua="""
local cleaned = text:match("^%s*(.-)%s*$")
""",
        shell="""
cleaned=$(echo "$text" | xargs)
""",
        sql="""
SELECT TRIM(name) AS cleaned FROM people;
""",
    ),
]
