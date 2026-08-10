import assert from "node:assert/strict";
import test from "node:test";
import { categoryChannelName, isAllSolved, normalizeCtfCategory, parseKstDateTime } from "../src/ctf/core";

test("CTF 문제 분야를 소문자 채널명으로 정규화한다", () => {
  assert.equal(normalizeCtfCategory(" Web Exploit "), "web-exploit");
  assert.equal(normalizeCtfCategory("PWN"), "pwn");
  assert.equal(normalizeCtfCategory(""), "misc");
});

test("대회 시각은 한국 시간으로 해석한다", () => {
  assert.equal(parseKstDateTime("2026-08-01 16:00"), Date.UTC(2026, 7, 1, 7, 0));
  assert.equal(parseKstDateTime("2026-02-30 10:00"), null);
});

test("추가된 미해결 문제가 있으면 All Solve를 해제한다", () => {
  assert.equal(isAllSolved([{ solved: true }, { solved: true }] as any), true);
  assert.equal(isAllSolved([{ solved: true }, { solved: false }] as any), false);
  assert.equal(isAllSolved([]), false);
});

test("분야 채널은 전부 풀렸을 때만 파란색이다", () => {
  assert.equal(categoryChannelName("rev", [{ solved: false }]), "⬜｜rev");
  assert.equal(categoryChannelName("rev", [{ solved: true }, { solved: true }]), "🟦｜rev");
  assert.equal(categoryChannelName("rev", []), "⬜｜rev");
});
