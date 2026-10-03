import { expect, test, type Browser, type Page } from '@playwright/test'

// These run against the mock AI provider (AI_PROVIDER=mock in
// playwright.config.ts): it adds a "PairPad AI: <instruction>" comment above
// the target code after a short delay, and passes every check.

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
const snap = async (page: Page, name: string) => {
  if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

const CODE = ['function add(a, b) {', '  return a + b', '}'].join('\n')

const editor = (page: Page) => page.locator('.cm-content')
const panel = (page: Page) => page.getByRole('complementary', { name: 'PairPad AI' })
const card = (page: Page, instruction: string) =>
  panel(page).getByRole('article', { name: `Suggestion: ${instruction}` })

/** The document as displayed, without remote cursor tags or suggestion widgets. */
function padText(page: Page): Promise<string> {
  return editor(page).evaluate((content) => {
    const copy = content.cloneNode(true) as HTMLElement
    copy
      .querySelectorAll('.cm-remoteCaret, .cm-placeholder, .cm-ai-header, .cm-ai-added')
      .forEach((node) => node.remove())
    return [...copy.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n')
  })
}

async function openPadWithCode(browser: Browser) {
  const alice = await (await browser.newContext({ viewport: { width: 1200, height: 640 } })).newPage()
  await alice.goto('/')
  await alice.getByRole('button', { name: 'New pad' }).click()
  await expect(alice).toHaveURL(/\/pad\//)
  // Inserted in one go, so auto-indent and bracket closing leave it as written.
  await editor(alice).click()
  await alice.keyboard.insertText(CODE)
  await expect.poll(() => padText(alice)).toBe(CODE)

  const bob = await (await browser.newContext({ viewport: { width: 1200, height: 640 } })).newPage()
  await bob.goto(alice.url())
  await expect.poll(() => padText(bob)).toBe(CODE)
  for (const page of [alice, bob]) await page.locator('.button-ai-toggle').click()
  return { alice, bob }
}

async function ask(page: Page, instruction: string) {
  await panel(page).getByLabel('Instruction').fill(instruction)
  await panel(page).locator('.button-ai').click()
}

const SUGGESTED = `// PairPad AI: add input validation\n${CODE}`

test('the AI joins, shows a suggestion to everyone, and Accept applies it for all', async ({ browser }) => {
  const { alice, bob } = await openPadWithCode(browser)
  await expect(panel(alice)).toContainText('10 of 10 left this hour')

  // Alice selects the whole function and asks.
  await editor(alice).click()
  await alice.keyboard.press('ControlOrMeta+a')
  await expect(panel(alice).locator('.ai-target')).toHaveText('Selection: lines 1 to 3')
  await ask(alice, 'add input validation')

  // Bob sees the AI arrive and its request in progress.
  await expect(bob.getByRole('button', { name: /plus PairPad AI/ })).toBeVisible()
  await expect(card(bob, 'add input validation')).toContainText('Writing a suggestion')
  await expect(bob.locator('.cm-remoteCaretTag', { hasText: 'PairPad AI' })).toHaveCount(1)
  await snap(bob, 'ai-working')

  // Then the suggestion, as a card and as an inline diff, for both.
  for (const page of [alice, bob]) {
    await expect(card(page, 'add input validation')).toHaveAttribute('data-status', 'pending')
    await expect(page.locator('.cm-ai-added-line')).toHaveText(['// PairPad AI: add input validation'])
    await expect(page.locator('.cm-ai-header')).toContainText('PairPad AI:')
  }
  await expect(bob.getByRole('button', { name: /plus PairPad AI/ })).toHaveCount(0)
  await expect(panel(alice)).toContainText('9 of 10 left this hour')
  // Nothing has changed in the code yet.
  expect(await padText(bob)).toBe(CODE)
  await snap(bob, 'ai-suggestion')

  await card(bob, 'add input validation').getByRole('button', { name: 'Accept' }).click()
  for (const page of [alice, bob]) {
    await expect.poll(() => padText(page)).toBe(SUGGESTED)
    await expect(card(page, 'add input validation')).toContainText('Accepted by')
    await expect(page.locator('.cm-ai-added-line')).toHaveCount(0)
  }
  await expect(alice.getByRole('button', { name: 'Ask AI' }).first()).not.toContainText(/\d/)
})

test('Reject from the bar in the editor discards it and leaves the code alone', async ({ browser }) => {
  const { alice, bob } = await openPadWithCode(browser)
  await ask(alice, 'add logging')
  await expect(bob.locator('.cm-ai-header')).toBeVisible()
  await expect(panel(bob).locator('.ai-target')).toContainText('No selection')

  await bob.locator('.cm-ai-header').getByRole('button', { name: 'Reject' }).click()
  for (const page of [alice, bob]) {
    await expect(card(page, 'add logging')).toContainText('Rejected by')
    await expect(page.locator('.cm-ai-header')).toHaveCount(0)
    expect(await padText(page)).toBe(CODE)
  }
})

test('two people clicking Accept at once apply it only once', async ({ browser }) => {
  const { alice, bob } = await openPadWithCode(browser)
  await ask(alice, 'add input validation')
  await expect(alice.locator('.cm-ai-header')).toBeVisible()
  await expect(bob.locator('.cm-ai-header')).toBeVisible()

  // Take hold of both buttons first, then press them together. Whichever
  // lands second may find its button already gone, which is fine.
  const buttons = await Promise.all([
    alice.locator('.cm-ai-header').getByRole('button', { name: 'Accept' }).elementHandle(),
    card(bob, 'add input validation').getByRole('button', { name: 'Accept' }).elementHandle(),
  ])
  await Promise.allSettled(buttons.map((button) => button!.click({ force: true, timeout: 2000 })))
  for (const page of [alice, bob]) {
    await expect.poll(() => padText(page)).toBe(SUGGESTED)
  }
  await bob.waitForTimeout(300)
  expect((await padText(alice)).split('PairPad AI:').length - 1).toBe(1)
})

test('a suggestion goes out of date when its code is edited, and cannot be accepted', async ({ browser }) => {
  const { alice, bob } = await openPadWithCode(browser)
  await ask(alice, 'add input validation')
  await expect(bob.locator('.cm-ai-header')).toContainText('PairPad AI:')

  // Alice edits inside the code the suggestion covers (line 2). Typing
  // right after its last character would stay outside the range.
  await editor(alice).click()
  await alice.keyboard.press('ControlOrMeta+Home')
  await alice.keyboard.press('ArrowDown')
  await alice.keyboard.press('End')
  await alice.keyboard.type(' // edited')
  for (const page of [alice, bob]) {
    await expect(page.locator('.cm-ai-header')).toContainText('out of date')
    await expect(page.locator('.cm-ai-header').getByRole('button', { name: 'Accept' })).toHaveCount(0)
  }

  // Accepting from the card is refused by the server, and everyone sees why.
  await card(bob, 'add input validation').getByRole('button', { name: 'Accept' }).click()
  await expect(card(bob, 'add input validation')).toContainText('code changed')
  await expect(card(alice, 'add input validation')).toHaveAttribute('data-status', 'stale')
  expect(await padText(bob)).toBe(CODE.replace('a + b', 'a + b // edited'))
  await snap(bob, 'ai-stale')
})
