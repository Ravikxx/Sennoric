import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLatestAlias } from '../src/index.js'

test('fresco-latest resolves to fresco-1.3 when it is not disabled', () => {
  assert.equal(resolveLatestAlias('fresco-latest', new Set()), 'fresco-1.3')
})

test('fresco-latest falls through to fresco when fresco-1.3 is kill-switched', () => {
  assert.equal(resolveLatestAlias('fresco-latest', new Set(['fresco-1.3'])), 'fresco')
})

test('fresco-latest falls back to the oldest version (fresco) if every fresco version is disabled', () => {
  assert.equal(resolveLatestAlias('fresco-latest', new Set(['fresco-1.3', 'fresco'])), 'fresco')
})

test('glyph-latest resolves to glyph when it is not disabled', () => {
  assert.equal(resolveLatestAlias('glyph-latest', new Set()), 'glyph')
})

test('glyph-latest still returns glyph (its only version) even when glyph is disabled, so the caller gets the real kill-switch message', () => {
  assert.equal(resolveLatestAlias('glyph-latest', new Set(['glyph'])), 'glyph')
})

test('a concrete model id is returned unchanged', () => {
  assert.equal(resolveLatestAlias('fresco-1.3', new Set()), 'fresco-1.3')
  assert.equal(resolveLatestAlias('fresco', new Set()), 'fresco')
  assert.equal(resolveLatestAlias('glyph', new Set()), 'glyph')
})

test('an unrelated/unknown model string is returned unchanged, not treated as an alias', () => {
  assert.equal(resolveLatestAlias('some-other-model', new Set()), 'some-other-model')
})
