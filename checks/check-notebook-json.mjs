#!/usr/bin/env node
import assert from 'node:assert/strict';
import { escapeInvalidJsonBackslashes, parseNotebookJson } from '../viewer/notebook-json.js';

const legacy = String.raw`{"cells":[{"kind":2,"value":"A = \[Alpha] + \[CurlyTheta]"}]}`;
assert.throws(() => JSON.parse(legacy));
assert.equal(parseNotebookJson(legacy).cells[0].value, String.raw`A = \[Alpha] + \[CurlyTheta]`);
assert.equal(parseNotebookJson(String.raw`{"value":"\u2014"}`).value, '—');
assert.equal(parseNotebookJson(String.raw`{"value":"\\u2014"}`).value, String.raw`\u2014`);
assert.ok(escapeInvalidJsonBackslashes(legacy).includes(String.raw`\\[Alpha]`));
assert.throws(() => parseNotebookJson('{"cells": [}'));
console.log('legacy notebook JSON checks passed');
