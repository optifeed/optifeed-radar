# PROTOCOL-NOTES.md - ACP + UCP feed requirements (M13 spike)

Verified current requirements for the two agentic-commerce protocols, captured
so M14's `lint-feed` rule set builds against pinned facts instead of a moving
target. **Every requirement below cites a primary source and the date it was
retrieved.** These specs are a live protocol war and shift; re-verify at release
(M17). This document is the input to M14 - each future rule
(`{id, protocol, severity, test, message, docsUrl}`) should map back to a line
here.

**Retrieved:** 2026-07-16. **Status of the field:** unstable (see per-source
notes). **Owner action at M17:** re-run every fetch below, diff, update dates.

---

## 0. TL;DR for M14

- There are **two protocols and three concrete feed surfaces**, not one:
  1. **ACP / OpenAI ChatGPT product feed** - a static, flat, uploadable feed
     that is **in production** and has a **strict required-field set**. This is
     the primary, lint-able target.
  2. **ACP Product Feeds RFC** - the protocol-standardization proposal;
     **Status: Proposal, Version: unreleased**. Minimal required set, nested
     shape. Emerging, not yet enforceable - lint leniently / advisory only.
  3. **UCP (Google-led)** - **not a static feed**; an API catalog capability
     (search/lookup). Its lint-able product-data surface is **Google Merchant
     Center product data + a `native_commerce` eligibility attribute**.
- **Identifier reality check:** the widely repeated claim "MPN is required when
  GTIN is absent" is **NOT** in the OpenAI ACP spec (both are optional; `brand`
  is the required identifier). Do not encode that rule. (See 2.1.)
- M14 should carry a `protocol` tag of `acp` | `ucp` | `both` per rule, and a
  `severity` that reflects surface maturity (production feed = error/warn; RFC
  and UCP-native = warn/info until firmed up).

---

## 1. Sources (all retrieved 2026-07-16)

### ACP - Agentic Commerce Protocol (maintained by OpenAI + Stripe)

| Source                                                                 | What it defines                     | Authority            | Notes                                     |
| ---------------------------------------------------------------------- | ----------------------------------- | -------------------- | ----------------------------------------- |
| https://developers.openai.com/commerce/specs/file-upload/products      | ChatGPT product feed fields (flat)  | Primary (maintainer) | In-production feed; strict required set   |
| https://developers.openai.com/commerce/specs/spec                      | Feed spec overview                  | Primary (maintainer) |                                           |
| https://github.com/agentic-commerce-protocol/agentic-commerce-protocol | ACP repo (spec + schemas)           | Primary (canonical)  | Checkout specs version-dated              |
| `rfcs/rfc.product_feeds.md` (same repo)                                | Product Feeds RFC                   | Primary              | **Status: Proposal, Version: unreleased** |
| `spec/2025-09-29` ... `spec/2026-01-30` (same repo)                    | Checkout / delegate-payment schemas | Primary              | Latest release dir: **2026-01-30**        |
| `examples/2026-04-17/examples.feed.json` (same repo)                   | Example feed payload                | Primary              | Newest dated example: 2026-04-17          |

Community mirrors (`agenticcommerce.pro`, `agentic-commerce-protocol.com`,
various vendor blogs) exist but are **NOT authoritative** - not cited here.

### UCP - Universal Commerce Protocol (Google-led; Shopify/Salesforce ecosystem)

| Source                                               | What it defines                    | Authority             | Notes                                    |
| ---------------------------------------------------- | ---------------------------------- | --------------------- | ---------------------------------------- |
| https://ucp.dev/                                     | UCP home / spec entry              | Primary               | Apache-2.0, "2026 UCP Authors"           |
| https://github.com/universal-commerce-protocol/ucp   | UCP repo (spec + JSON schemas)     | Primary (canonical)   |                                          |
| `docs/specification/catalog/index.md` (same repo)    | Catalog capability (search/lookup) | Primary               | API capability, not a feed file          |
| `source/schemas/shopping/types/product.json`         | Product entity schema              | Primary               | `required` array is authoritative        |
| `source/schemas/shopping/types/variant.json`         | Variant entity schema              | Primary               |                                          |
| `source/schemas/shopping/types/availability.json`    | Availability entity                | Primary               |                                          |
| https://developers.google.com/merchant/ucp           | Google's UCP merchant guide        | Primary (implementer) | Leverages existing Merchant Center feeds |
| https://support.google.com/merchants/answer/16837055 | `native_commerce` attribute        | Primary (implementer) | Product-level UCP-checkout eligibility   |

---

## 2. ACP requirements

### 2.1 OpenAI ChatGPT product feed (flat, in production) - THE primary lint target

Source: `developers.openai.com/commerce/specs/file-upload/products` (2026-07-16).
Feed file formats accepted: **JSON, CSV, TSV, XML**; feed must be refreshed
regularly (staleness discouraged). Dates use **ISO 8601**; URLs must be
**HTTPS-resolvable**; price carries an **ISO 4217** currency; countries use
**ISO 3166-1 alpha-2**.

**Strictly required (15):** `item_id` (<=100 chars, stable), `title`
(<=150 chars), `description` (<=5000 chars), `url`, `brand` (<=70 chars),
`image_url`, `price` (+currency), `availability`
(`in_stock|out_of_stock|pre_order|backorder|unknown`), `seller_name`,
`seller_url`, `target_countries`, `store_country`, `is_eligible_search` (bool),
`is_eligible_checkout` (bool; requires `is_eligible_search=true`),
`is_ads_eligible` (bool; verify whether ads-context-only at M17).

**Conditionally required:**

- `availability_date` - when `availability=pre_order` (ISO 8601, future date).
- `seller_privacy_policy` - when `is_eligible_checkout=true` (HTTPS URL).
- `seller_tos` - when `is_eligible_checkout=true` (HTTPS URL).
- `dimensions_unit` - when any of `length`/`width`/`height` provided.
- `item_weight_unit` - when `weight` provided.
- `return_policy` - flagged required by the Returns section heading; **pin exact
  condition at M17** (heading vs field-level requiredness was ambiguous).

**Identifiers (all optional; there is NO GTIN/MPN interdependency in the spec):**

- `brand` - **required** (the one required identifier).
- `gtin` - optional; 8-14 digits, no dashes/spaces (covers GTIN/UPC/ISBN).
- `mpn` - optional; <=70 chars.
- **DO NOT encode** "MPN required when GTIN absent" - that circulates on vendor
  blogs but is not in the primary spec (verified 2026-07-16). M14 may still
  _warn_ "no product identifier (gtin/mpn) supplied - hurts agent matching" as
  advisory, tagged severity=info, but never as a spec-required error.

### 2.2 ACP Product Feeds RFC (proposal, unreleased) - advisory only

Source: `rfcs/rfc.product_feeds.md` (2026-07-16). **Status: Proposal, Version:
unreleased.** Nested `Product -> variants[] -> Variant` model (NOT the flat
2.1 shape). Barcodes/GTIN appear as an optional `barcodes[]` array on the
variant, not flat fields.

**MUST (the only hard requirements):**

- Product records MUST include a stable `Product.id`.
- Product records MUST include `variants`.
- Variant records MUST include a stable `Variant.id` and `title`.
- (Protocol/transport MUSTs - HTTPS, `Authorization`, `API-Version`, checkout
  authoritative over feed - are out of feed-linting scope.)

**Optional (SHOULD/MAY):** `Product.title/description/url/media`;
`Variant.description/url/media/price/list_price/unit_price/availability/`
`categories/condition/variant_options/seller/marketplace`. Availability status
enum: `in_stock|backorder|preorder|out_of_stock|discontinued`. Prices use
`amount` in **ISO 4217 minor units** + `currency`.

**M14 stance:** treat 2.2 as the emerging standard - lint against it only as
advisory (`severity=info`) until it leaves proposal status. The enforceable ACP
target today is 2.1.

---

## 3. UCP requirements

### 3.1 Architecture - it is an API, not a feed

Source: `docs/specification/catalog/index.md` (2026-07-16). UCP's Catalog
capability is a **live API** (`dev.ucp.shopping.catalog.search` /
`...catalog.lookup`) over REST / MCP / A2A, returning Product/Variant/Price
objects on demand. There is **no static UCP feed file to lint** the way ACP 2.1
has. What M14 can validate for a UCP-oriented merchant is the **product-data
shape** the API must return, plus (for Google's concrete implementation) the
Merchant Center feed that backs it.

### 3.2 UCP catalog entity requirements (from the JSON schemas)

Sources: `source/schemas/shopping/types/{product,variant,availability}.json`
(2026-07-16). `required` arrays are authoritative:

- **Product** required: `id`, `title`, `description`, `price_range`, `variants`.
  Optional: `handle`, `url`, `categories`, `list_price_range`, `media`,
  `options`, `rating`, `tags`, `metadata`.
- **Variant** required: `id`, `title`, `description`, `price`.
  Optional identifiers: `sku`, `barcodes[]` (industry-standard IDs - GTIN/UPC).
  Optional: `url`, `categories`, `list_price`, `unit_price`, `availability`,
  `options`, `media`, `rating`, `tags`, `seller`, `metadata`.
- **Availability**: no required fields; `available` (bool) + `status`
  (well-known values incl. `in_stock`, ...). Optional overall.
- **Price**: `amount` in **minor currency units** + ISO 4217 `currency`
  (`common/types/price.json`).
- IDs are **GIDs** (global IDs); `Variant.id` is used as the checkout item id.

### 3.3 Google's concrete UCP feed surface

Sources: `developers.google.com/merchant/ucp`,
`support.google.com/merchants/answer/16837055` (2026-07-16). Google's
UCP-powered checkout **reuses existing Google Merchant Center product feeds**;
merchants opt individual products in with a product-level **`native_commerce`**
attribute (recommended via a supplemental data source, not the primary feed).
Practical implication: for a Google/UCP merchant, the lint-able requirements are
**the Google Merchant Center product data spec** (GTIN/MPN/brand, availability,
price, image_link, shipping, returns) **plus `native_commerce` eligibility**.
The GMC product spec itself is large and separately versioned - **not
transcribed here; pin the exact GMC required set when M14 needs it** (own
sub-task, cite the GMC spec URL + date at that time).

---

## 4. Cross-protocol comparison

| Aspect         | ACP - OpenAI feed (2.1)             | ACP RFC (2.2)                    | UCP catalog (3.2)                                                                       |
| -------------- | ----------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Surface        | Static flat feed (JSON/CSV/TSV/XML) | Nested feed (proposal)           | Live API (search/lookup)                                                                |
| Maturity       | In production                       | Proposal / unreleased            | Published spec; Google impl live                                                        |
| Required core  | 15 fields (see 2.1)                 | id + variants + variant id/title | Product: id,title,description,price_range,variants; Variant: id,title,description,price |
| Identifiers    | brand required; gtin/mpn optional   | barcodes[] optional              | sku + barcodes[] optional                                                               |
| Price format   | number + ISO 4217                   | minor units + ISO 4217           | minor units + ISO 4217                                                                  |
| Availability   | enum (5 values)                     | enum (5 values)                  | available bool + status                                                                 |
| Returns/policy | return_policy + seller policy links | seller/policy optional           | via GMC spec (Google impl)                                                              |

**Convergent (safe to encode as `protocol: both`):** ISO 4217 currency; stable
product/variant identifiers; an availability signal; HTTPS media/URLs; a title.
**Divergent (encode per-protocol):** required-field breadth (ACP-feed is strict,
RFC + UCP are lean), flat-vs-nested shape, price scalar-vs-minor-units, and
whether the surface is a feed at all (UCP is not).

---

## 5. Open questions to pin at M17 (each blocks a precise M14 rule)

1. **ACP `return_policy` requiredness** - section heading implied required;
   confirm field-level condition (2.1).
2. **ACP `is_ads_eligible`** - always-required vs ads-context-only (2.1).
3. **ACP RFC status** - has the Product Feeds RFC left "Proposal / unreleased"?
   If released + version-dated, promote 2.2 rules from advisory to enforceable.
4. **UCP required set stability** - re-pull the three schema `required` arrays;
   watch for `price_range` / `variants` churn.
5. **Google Merchant Center product spec** - transcribe the exact GMC required
   set + `native_commerce` mechanics when M14 builds UCP-Google rules (3.3).
6. **GTIN/MPN guidance drift** - re-confirm no interdependency rule appeared
   (2.1); vendor blogs disagree with the primary spec.

---

## 6. Mapping to M14 rules (starter set - source line each rule cites)

Each row is a candidate M14 rule `{id, protocol, severity, test, message, docsUrl}`.

| Candidate rule id                   | protocol | severity | maps to                           |
| ----------------------------------- | -------- | -------- | --------------------------------- |
| `acp.required.<field>` (x15)        | acp      | error    | 2.1 strictly-required             |
| `acp.conditional.seller_policy`     | acp      | error    | 2.1 (checkout-eligible)           |
| `acp.conditional.availability_date` | acp      | error    | 2.1 (pre_order)                   |
| `acp.identifier.brand_present`      | acp      | error    | 2.1 (brand required)              |
| `acp.identifier.gtin_or_mpn`        | acp      | info     | 2.1 (advisory, NOT spec-required) |
| `acp.format.iso4217_price`          | both     | error    | 2.1 / 2.2 / 3.2                   |
| `acp.format.iso8601_dates`          | acp      | error    | 2.1                               |
| `acp.format.https_urls`             | both     | warn     | 2.1 / RFC security                |
| `acp_rfc.required.ids`              | acp      | info     | 2.2 (advisory until released)     |
| `ucp.required.product_core`         | ucp      | error    | 3.2 product schema                |
| `ucp.required.variant_core`         | ucp      | error    | 3.2 variant schema                |
| `ucp.google.native_commerce`        | ucp      | warn     | 3.3 (Google impl eligibility)     |
| `ucp.google.gmc_product_spec`       | ucp      | error    | 3.3 (pin GMC set at M17)          |

See section 7 for the reconciliation with the Rails feed-quality logic (M14's
other input), now done.

---

## 7. Reconciliation with the Rails agent-readiness logic

Source: the Optifeed Rails app, branch `ai-visibility-crawler`,
`app/models/concerns/export/agent_readiness.rb` +
`app/models/export/description_sanitizer.rb` (read 2026-07-16). This is M14's
OTHER input, alongside the protocol specs above.

**What the Rails logic is:** a per-SKU **completeness/quality** checklist ("agent
readiness"), NOT protocol conformance. Its rule table (`GAPS`) checks presence
and description quality, tags each gap `:manual` (human fix) or `:llm`
(auto-fillable), and rolls the gaps into a per-field graded readiness score
(share of gap-free `sku x field` cells, 0-100). The scored fields are `title`,
`description`, `brand`, `image_url`, `gtin`, `q_and_a`.

**Rails `GAPS` rules (verbatim intent):**

| Rails gap code             | field       | test                                          | strategy |
| -------------------------- | ----------- | --------------------------------------------- | -------- |
| `missing_title`            | title       | blank                                         | manual   |
| `missing_description`      | description | blank                                         | llm      |
| `thin_description`         | description | `< 20` sanitized chars                        | llm      |
| `misformatted_description` | description | sanitizing strips significant HTML/JS residue | llm      |
| `missing_brand`            | brand       | blank                                         | llm      |
| `missing_image`            | image_url   | blank                                         | manual   |
| `missing_gtin`             | gtin        | blank                                         | manual   |
| `missing_q_and_a`          | q_and_a     | always a gap unless overridden                | llm      |

Notable: `DescriptionSanitizer.MAX_CHARS = 5000` **matches ACP's description max
exactly**; `THIN_DESCRIPTION_CHARS = 20`. Rails does **no format validation**
(no GTIN digit-count, no ISO-8601 date, no HTTPS-URL, no ISO-4217 checks) and
carries **no protocol tag** - every gap is generic quality.

**The merge (this is the M14 rule set):** take the union, and resolve severity
by combining Rails-quality with protocol-requiredness. Two genuine conflicts:

| field                             | Rails says                  | Protocol (2.1 ACP) says              | -> M14 resolution                                             |
| --------------------------------- | --------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `brand`                           | quality gap, llm-fixable    | **REQUIRED**                         | **error** (protocol wins; still llm-fixable metadata)         |
| `gtin`                            | `missing_gtin` gap (manual) | **optional**, no MPN interdependency | **info/advisory** - never a hard error (matches 2.1)          |
| `title`                           | quality gap (manual)        | required                             | error                                                         |
| `image_url`                       | quality gap (manual)        | required                             | error                                                         |
| `description` (missing)           | quality gap                 | required, max 5000                   | error if blank                                                |
| `description` (thin/misformatted) | quality gaps                | not specified by protocol            | **warn** (quality-only, keep Rails' 20-char + sanitizer test) |
| `q_and_a`                         | quality gap                 | optional (ACP/UCP)                   | **info** (quality signal, not conformance)                    |

**What each input uniquely contributes to M14:**

- From the **protocols** (not in Rails): format validators (GTIN 8-14 digits,
  ISO 8601 dates, ISO 4217 currency, HTTPS URLs), the availability enum,
  conditional rules (seller policy when checkout-eligible, availability_date on
  pre_order), and the `protocol` tag (`acp`/`ucp`/`both`).
- From **Rails** (not in the protocols): description **quality** beyond presence
  (thin < 20 chars; misformatted = HTML/JS residue via the shared sanitizer),
  the `q_and_a` signal, the `:manual`/`:llm` auto-fixability dimension (useful
  as rule metadata, not a pass/fail), and a proven **per-field graded feed
  score** model M14's feed-level summary score can reuse (share of gap-free
  cells, description's 3 codes collapsing to one field so a bad description
  counts once).

**M14 build note:** port the Rails `GAPS` table as the quality-rule seed, layer
the protocol conformance + format rules from sections 2-3 on top, tag every rule
with `protocol` + a severity resolved per the table above, and reuse the Rails
per-field graded scoring for the feed-level summary. The `strategy` (manual/llm)
maps cleanly to a future auto-fix hook but is out of M14's lint scope.
