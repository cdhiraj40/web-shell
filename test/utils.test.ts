import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveApplicationIdFromUrl,
  deriveApplicationIdSuggestionFromUrl,
  derivePackageNameSuggestionFromApplicationId,
  validateApplicationId,
} from "../src/lib/utils.ts";

test("deriveApplicationIdFromUrl keeps reserved segments in the Android application ID", () => {
  assert.equal(
    deriveApplicationIdFromUrl("https://cfl.fun/"),
    "fun.cfl",
  );
});

test("deriveApplicationIdFromUrl keeps www in the Bubblewrap-style host reversal", () => {
  assert.equal(
    deriveApplicationIdFromUrl("https://www.cfl.fun/"),
    "fun.cfl.www",
  );
});

test("deriveApplicationIdSuggestionFromUrl only explains Android-safe normalization", () => {
  const suggestion = deriveApplicationIdSuggestionFromUrl("https://wallet-1.example.com/");

  assert.equal(suggestion.applicationId, "com.example.wallet_1");
  assert.match(suggestion.note ?? "", /keep it Android-safe/);
});

test("derivePackageNameSuggestionFromApplicationId rewrites reserved segments for Kotlin", () => {
  const suggestion = derivePackageNameSuggestionFromApplicationId("fun.cfl.www");

  assert.equal(suggestion.packageName, "_fun.cfl.www");
  assert.match(suggestion.note ?? "", /reserved word in Kotlin\/Java/);
});

test("validateApplicationId allows reserved segments but still enforces Android syntax", () => {
  assert.equal(validateApplicationId("fun.cfl.app"), undefined);
  assert.match(
    validateApplicationId("Fun.cfl.app") ?? "",
    /must look like com\.example\.app/,
  );
});
