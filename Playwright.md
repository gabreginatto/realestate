Awesome—let’s make this turnkey for Claude Code + **Playwright MCP**.
Copy-paste the block below into Claude Code exactly as-is, then replace the ALL-CAPS placeholders where noted.

---

# ✅ Master Prompt for Page-by-Page Workflow (Playwright MCP + Filesystem MCP)

**Goal**
We will work **page by page** to build durable Playwright scripts for `https://www.vivaprimeimoveis.com.br/`.
For each page (e.g., homepage → search results → listing detail), you will:

1. Open the page in a real browser (Playwright MCP).
2. Extract the **rendered DOM/HTML** and build a **selectors map** with stable locators.
3. Ask me: **“What do you want Playwright to do here?”**
4. Convert my answer into a fully runnable **Playwright TypeScript** script that uses those selectors (no coordinate clicks).
5. Save all artifacts via Filesystem MCP.

---

## 🔧 Tools to use

* **Playwright MCP**: `browser_navigate`, `browser_wait_for`, `browser_click`, `browser_type`, `browser_select_option`, `browser_evaluate`, `browser_screenshot`, `browser_get_url`, `browser_get_title`.
* **Filesystem MCP**: `fs_write_text`, `fs_write_binary`, `fs_mkdirp`, `fs_list`.

Do **not** use any coordinate/vision clicks. Prefer semantic/accessible locators and stable attributes.

---

## 📁 Project settings (fill before starting)

* DOMAIN_SLUG = `vivaprimeimoveis`
* ROOT_URL = `https://www.vivaprimeimoveis.com.br/`
* OUT_DIR = `data/${DOMAIN_SLUG}`
* SCRIPTS_DIR = `scripts`

Create folders:

* `${OUT_DIR}/home/` for homepage artifacts
* `${OUT_DIR}/detail/` for a listing detail page artifacts (later)
* `${SCRIPTS_DIR}/` for generated Playwright scripts

---

## 🧭 Selector rules (very important)

When constructing selectors, follow this priority order:

1. **ARIA roles with accessible names** (Playwright: `page.getByRole('button', { name: 'Buscar' })`)
2. **Stable attributes**: `[data-testid]`, `[data-qa]`, `id`, `name`
3. **Robust CSS**: short, class-light, and only use `:nth-of-type()` if unavoidable
4. **Text locators** are OK if the text is stable and unique (avoid long strings)

For each element you record, store:

* `strategy` (role | testid | id | name | css | text)
* `value` (the actual locator input)
* `playwright` (the final code snippet, e.g., `page.getByRole('button', { name: 'Buscar' })`)
* `why` (one sentence on why it’s stable)
* `fallbacks[]` (ordered list of alternatives if the main locator breaks)

---

## 🏁 PAGE 1: Homepage flow

**Do this now:**

1. **Navigate & settle**

* `browser_navigate` to `${ROOT_URL}`
* Handle cookie/privacy banners minimally (accept only required).
* `browser_wait_for` until the main search form or hero area is visible.

2. **Capture**

* `browser_get_url` and `browser_get_title`
* `browser_screenshot` full page → save as `${OUT_DIR}/home/homepage.png`
* `browser_evaluate` → return:

  * `html`: `document.documentElement.outerHTML`
  * A **structured JSON** (`selectors_home.json`) with the best locators for likely controls on this site’s homepage (fill whatever exists):

    * search form container
    * **operation type** (e.g., Comprar/Alugar) control
    * **property type** (e.g., Casa/Apartamento) control
    * **location** input/autocomplete
    * **price min / price max** inputs or sliders
    * **bedrooms** control
    * **search button**
    * any **featured listing cards** (card container, title/address, price, link)
* Save files:

  * `${OUT_DIR}/home/homepage.html`
  * `${OUT_DIR}/home/selectors_home.json`
  * `${OUT_DIR}/home/homepage.png`

3. **Show me a quick preview**

* Print the discovered keys and their `playwright` snippets (first ~10 entries), e.g.:

  * `search.form` → `page.locator('[data-testid="search-form"]')`
  * `search.propertyType` → `page.getByRole('combobox', { name: 'Tipo' })`
  * `search.submit` → `page.getByRole('button', { name: 'Buscar' })`
* Then ask me:
  **“What do you want Playwright to do on the HOME page?”**
  Provide this hint: *“Reply in natural language or using keys from `selectors_home.json`. Examples: ‘select Casa in property type, set max price 900k, set location Moema, then click Buscar and wait for results’.”*

4. **Turn my answer into a script**

* Parse my intent and produce **`scripts/home-${DOMAIN_SLUG}.spec.ts`** with:

  * imports: `import { test, expect } from '@playwright/test'`
  * test name: `'Home search for vivaprimeimoveis'`
  * steps using the **stored selectors**:

    * navigate to `${ROOT_URL}`
    * manipulate the controls as per my answer (use `getByRole`/semantic locators first)
    * apply any waits like `await expect(locator).toBeVisible()` where needed
    * finish by navigating to results (or staying on page if action is just opening filters)
  * **No MCP calls in the generated script**; pure Playwright.
* Save the script file and print it in full.
* Also generate a short **README** section with the command to run:

  ```
  npx playwright test scripts/home-${DOMAIN_SLUG}.spec.ts --project=chromium
  ```

**Stop and wait for my reply** after showing the preview + asking the question.

---

## 🏠 Example “user intent” you should accept

Natural language is fine. You can also accept keys from `selectors_home.json`.
Examples you should understand and implement:

* “Select **Casa**, set **Preço Máximo** to **900000**, set **Bairro** to **Moema**, then click **Buscar**.”
* “Choose **Comprar**, **Apartamento**, **2+ quartos**, and search.”
* “Click the first featured card to open the detail page (in same tab).”

If the exact control doesn’t exist, ask a brief clarifying question or propose the closest alternative.

---

## 🧩 After the homepage is done (I will tell you when)

We’ll repeat the same extraction → ask → script flow for a **listing detail page**:

1. Either: click a listing from homepage/results, or I’ll paste a listing URL.
2. Capture `${OUT_DIR}/detail/detail.html`, `${OUT_DIR}/detail/detail.png`, and `selectors_detail.json` with stable locators for:

   * title/address
   * price
   * characteristics (beds, baths, area)
   * photo carousel next/prev
   * amenities list
   * agent/phone/WhatsApp/contact buttons (but **never** auto-send messages)
   * map/open map
3. Ask me **“What do you want Playwright to do on the DETAIL page?”**
   (e.g., “open the gallery, go to 5th photo, grab caption; click WhatsApp button but stop before sending.”)
4. Generate **`scripts/detail-${DOMAIN_SLUG}.spec.ts`** (pure Playwright) and show it in full.

---

## 🧪 Quality & safety checks

* Always justify each chosen selector with a short **why** and suggest **fallbacks**.
* Use `await expect(locator).toBeVisible()` after major nav/filter actions.
* If a cookie/banner blocks interaction, dismiss it first using a stable locator.
* Never try to bypass CAPTCHAs or submit real messages to agents/WhatsApp.
* Respect the site’s terms and rate limits; no excessive parallelism.

---

## ▶️ Start with PAGE 1 now

1. Create folders.
2. Navigate to `${ROOT_URL}`.
3. Extract **homepage HTML**, **screenshot**, and **selectors_home.json** as specified.
4. Show me a compact preview of the discovered selectors and **ask me what I want to do** on the HOME page.
5. After my reply, generate `scripts/home-${DOMAIN_SLUG}.spec.ts` and print it in full.

---

### (Optional) Mini action language you can accept from me

I might also reply with a tiny DSL to be extra precise (you can still accept natural language):

```
- select: search.propertyType label "Casa"
- select: search.operation label "Comprar"
- type:   search.location "Moema, São Paulo"
- type:   search.priceMax "900000"
- click:  search.submit
- waitForVisible: results.grid
```

Map each step to the best locator from your selectors JSON.

---

**That’s it—begin PAGE 1 (Home) now.**
