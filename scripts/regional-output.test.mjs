import test from 'node:test'
import assert from 'node:assert/strict'
import { compactFact, compactLookup } from '../lib/backend.js'

const oldPack = {
  text: 'Character: Ichika\nID: character:1', trust: 'A', language: 'en',
  fact_pack_tokens: 12, raw_json_tokens: 80, token_ratio: 0.15,
}

const scopedPack = (changes = {}) => ({
  ...oldPack, entity_id: 'character_profile:18',
  region: 'en', region_scope: 'region', coverage: 'available',
  needs_region: false, available_regions: ['en', 'jp'],
  content_status: 'available', effective_language: 'en',
  body_field: 'introduction_en', source: 'master_db:en', version: 'snapshot-1',
  text: 'Character_profile: Mafuyu\nRegions: en\nProfile: Handles lyrics.',
  ...changes,
})

const lookupRow = (changes = {}) => ({
  id: 'character_profile:18', type: 'character_profile', trust: 'A', score: 100,
  regions: ['en', 'jp'], names: { en: 'Mafuyu' }, facts: { height: '162cm' },
  ...changes,
})

test('legacy FactPack output stays identical when scope metadata is absent', () => {
  const text = compactFact(oldPack)
  assert.equal(text, oldPack.text + '\ntrust=A fact_pack_tokens=12\uff08\u539f\u59cb JSON 80\uff0c\u538b\u7f29\u6bd4 0.15\uff09')
  assert.equal(compactFact(null), '\u672a\u627e\u5230\u8be5\u5b9e\u4f53\uff0c\u8bf7\u5148\u7528 sekai_lookup \u786e\u8ba4 id')
})

test('selected-region FactPack keeps scope, language, source and body', () => {
  const text = compactFact(scopedPack())
  assert.ok(text.startsWith('scope: region=en region_scope=region coverage=available content_status=available needs_region=false'))
  for (const part of ['available_regions=en,jp', 'effective_language=en', 'requested_language=en',
    'body_field=introduction_en', 'source=master_db:en', 'version=snapshot-1', 'Handles lyrics.']) {
    assert.ok(text.includes(part), part)
  }
  assert.ok(text.indexOf('source=master_db:en') < text.indexOf('Profile:'))
})

test('long FactPack bodies cannot truncate missing or conflicting state markers', () => {
  const text = compactFact(scopedPack({
    region: null, region_scope: 'common', coverage: 'needs_region',
    content_status: 'needs_region', needs_region: true, effective_language: null,
    source: null, body_field: null, text: 'x'.repeat(12000),
  }))
  for (const part of ['region=unscoped', 'coverage=needs_region', 'content_status=needs_region',
    'needs_region=true', 'available_regions=en,jp', 'select region with sekai_fact', 'source=unknown']) {
    assert.ok(text.includes(part), part)
    assert.ok(text.indexOf(part) < text.indexOf('xxxxxxxx'), part)
  }
  assert.ok(text.length < 4100)
})

test('missing content is explicit and does not invent a fallback body', () => {
  const text = compactFact(scopedPack({
    region: 'cn', coverage: 'missing', content_status: 'missing',
    effective_language: null, body_field: null, source: null, text: '',
  }))
  assert.match(text, /content_status=missing/)
  assert.match(text, /Requested content is missing/)
  assert.match(text, /do not substitute another region/)
  assert.match(text, /effective_language=missing/)
  assert.ok(!text.includes('Handles lyrics.') && !text.includes('undefined'))
})

test('language fallback remains explicit before the body', () => {
  const text = compactFact(scopedPack({ region: 'jp', effective_language: 'ja',
    body_field: 'introduction_ja', source: 'master_db:jp',
    text: 'Body Language: ja (requested: en)\nProfile: JP body',
  }))
  assert.match(text, /requested_language=en/)
  assert.match(text, /effective_language=ja/)
  assert.match(text, /Body Language: ja \(requested: en\)/)
  assert.ok(text.indexOf('effective_language=ja') < text.indexOf('Profile:'))
})

test('unknown legacy coverage and unsuffixed body language are not made regional', () => {
  const text = compactFact(scopedPack({
    region: null, region_scope: 'entity', coverage: 'unknown', available_regions: [],
    effective_language: '', body_field: 'profile', source: '',
  }))
  assert.match(text, /region=unscoped region_scope=entity coverage=unknown/)
  assert.match(text, /Coverage is unknown/)
  assert.match(text, /effective_language=unknown/)
  assert.match(text, /source=unknown/)
})

test('legacy lookup output stays identical without regional metadata', () => {
  const text = compactLookup({ query: 'Mafuyu', results: [lookupRow({ source: 'master_db' })] })
  assert.equal(text, 'query: Mafuyu\n\u2022 character_profile:18 [character_profile] trust=A score=100 regions=en,jp\n  names: en=Mafuyu\n  facts: height=162cm')
})

test('unscoped lookup distinguishes common facts from regional body evidence', () => {
  const text = compactLookup({ query: 'Handles lyrics', results: [lookupRow({
    region: null, coverage: 'needs_region', needs_region: true,
    field_status: { height: 'available', introduction_en: 'partial', introduction_ja: 'partial' },
    region_facts: {
      jp: { source: 'master_db:jp', version: 'jp-1', facts: { introduction_ja: 'JP body', height: '162cm' } },
      en: { source: 'master_db:en', version: 'en-1', facts: { introduction_en: 'Handles lyrics.', height: '162cm' } },
    },
  })] })
  assert.match(text, /facts\(common\): height=162cm/)
  assert.match(text, /regional evidence \(not common facts; previews only\)/)
  assert.match(text, /\[en\] source=master_db:en version=en-1\n      facts: introduction_en=Handles lyrics\./)
  assert.match(text, /\[jp\] source=master_db:jp version=jp-1/)
  assert.match(text, /coverage=needs_region needs_region=true/)
  assert.match(text, /field_status: introduction_en=partial introduction_ja=partial/)
  const commonLine = text.split('\n').find((line) => line.includes('facts(common):'))
  assert.ok(!commonLine.includes('introduction'))
})

test('regional previews prioritize matching descriptions after many scalar fields', () => {
  const facts = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`scalar${i}`, i]))
  facts.introduction_en = 'Late matched role body'
  const text = compactLookup({ query: 'matched role', results: [lookupRow({
    region: null, coverage: 'needs_region', needs_region: true,
    region_facts: { en: { facts, source: 'master_db:en' } },
  })] })
  assert.match(text, /facts: introduction_en=Late matched role body/)
  assert.ok(!text.includes('scalar19='))
})

test('scoped lookup labels facts with the selected region instead of common scope', () => {
  const text = compactLookup({ query: 'JP body', results: [lookupRow({
    region: 'jp', coverage: 'available', needs_region: false, source: 'master_db:jp',
    facts: { introduction_ja: 'JP body' }, field_status: { introduction_ja: 'available' },
  })] })
  assert.match(text, /scope: region=jp coverage=available needs_region=false/)
  assert.match(text, /source: master_db:jp/)
  assert.match(text, /facts\(region=jp\): introduction_ja=JP body/)
  assert.ok(!text.includes('facts(common)') && !text.includes('regional evidence'))
})

test('regional preview retains a case-insensitive query match late in a long body', () => {
  const text = compactLookup({ query: 'handles lyrics', results: [lookupRow({
    region: null, coverage: 'needs_region', needs_region: true,
    region_facts: { en: { facts: { introduction_en: 'Unrelated sentence. '.repeat(40) + 'Handles lyrics. Closing sentence.' } } },
  })] })
  assert.match(text, /introduction_en=.*Handles lyrics\./)
  assert.ok(text.length < 1500)
})

test('legacy unscoped facts retain unknown coverage in lookup', () => {
  const text = compactLookup({ query: 'Legacy', results: [lookupRow({
    region: 'jp', coverage: 'unknown', needs_region: false, facts: {},
    field_status: { profile: 'unknown' }, legacy_unscoped: { facts: { profile: 'Legacy body' } },
  })] })
  assert.match(text, /Coverage is unknown/)
  assert.match(text, /field_status: profile=unknown/)
  assert.match(text, /legacy_unscoped \(coverage unknown\): profile=Legacy body/)
  assert.ok(!text.includes('facts(region=jp): profile='))
})

test('regional previews disclose omitted regions and preserve input data', () => {
  const regional = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`r${i}`, { facts: { profile_en: 'Body ' + i } }]))
  const input = { query: 'Body', results: [lookupRow({ region: null, coverage: 'available', region_facts: regional })] }
  const before = structuredClone(input)
  const text = compactLookup(input)
  assert.match(text, /2 more regions omitted; select region for details/)
  assert.deepEqual(input, before)
})
