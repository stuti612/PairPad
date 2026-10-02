import { expect, test, type Browser, type Page } from '@playwright/test'

// Set SCREENSHOT_DIR to save a picture of each window at the end of a test.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR

async function snap(page: Page, name: string): Promise<void> {
  if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

/** Two separate browser windows (separate contexts, so nothing is shared but the server). */
async function openTwoWindows(browser: Browser): Promise<{ alice: Page; bob: Page }> {
  const aliceContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const bobContext = await browser.newContext()
  const alice = await aliceContext.newPage()
  const bob = await bobContext.newPage()

  await alice.goto('/')
  await alice.getByRole('button', { name: 'New pad' }).click()
  await expect(alice).toHaveURL(/\/pad\/[a-z0-9]{8}$/)
  await bob.goto(alice.url())
  await expect(bob.locator('.cm-content')).toBeVisible()
  return { alice, bob }
}

const editor = (page: Page) => page.locator('.cm-content')

async function typeInto(page: Page, text: string, delay = 0): Promise<void> {
  await editor(page).click()
  await page.keyboard.type(text, { delay })
}

test('landing page creates a pad and explains how it works', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'PairPad' })).toBeVisible()

  await page.getByRole('button', { name: 'How it works' }).click()
  await expect(page.locator('#how-it-works')).toContainText('CRDT')
  await snap(page, 'landing')

  await page.getByRole('button', { name: 'New pad' }).click()
  await expect(page).toHaveURL(/\/pad\/[a-z0-9]{8}$/)
  const roomId = page.url().split('/').pop()!
  await expect(page.locator('.room-id')).toHaveText(roomId)
  await expect(editor(page)).toBeFocused()
})

test('each "New pad" gets its own room', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New pad' }).click()
  await expect(page).toHaveURL(/\/pad\//)
  const first = page.url()

  await page.getByRole('link', { name: 'PairPad' }).click()
  await page.getByRole('button', { name: 'New pad' }).click()
  await expect(page).toHaveURL(/\/pad\//)
  expect(page.url()).not.toBe(first)
})

test('typing in one window shows up in the other, in both directions', async ({ browser }) => {
  const { alice, bob } = await openTwoWindows(browser)

  await typeInto(alice, 'hello from alice')
  await expect(editor(bob)).toHaveText('hello from alice')

  await typeInto(bob, ' and bob')
  await expect(editor(alice)).toContainText('and bob')
  await expect(editor(alice)).toHaveText(await editor(bob).innerText())
})

test('both windows typing at once converge with every character kept', async ({ browser }) => {
  const { alice, bob } = await openTwoWindows(browser)
  const count = 40

  await editor(alice).click()
  await editor(bob).click()
  await Promise.all([
    alice.keyboard.type('a'.repeat(count), { delay: 5 }),
    bob.keyboard.type('b'.repeat(count), { delay: 5 }),
  ])

  await expect
    .poll(async () => (await editor(alice).innerText()).length + (await editor(bob).innerText()).length)
    .toBe(count * 4)
  const text = await editor(alice).innerText()
  expect(await editor(bob).innerText()).toBe(text)
  expect(text.split('a').length - 1).toBe(count)
  expect(text.split('b').length - 1).toBe(count)
})

test('the language picker syncs and changes highlighting for everyone', async ({ browser }) => {
  const { alice, bob } = await openTwoWindows(browser)
  const picker = (page: Page) => page.getByLabel('Language')
  // Colour of the word "def": a keyword in Python, plain text otherwise.
  const defColor = (page: Page) =>
    editor(page).evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.startsWith('def')) {
          return getComputedStyle(walker.currentNode.parentElement!).color
        }
      }
      return null
    })

  await expect(picker(alice)).toHaveValue('javascript')
  await expect(picker(bob)).toHaveValue('javascript')
  await typeInto(alice, 'def greet(): return 1')
  await expect(editor(bob)).toHaveText('def greet(): return 1')
  const before = await defColor(bob)

  await picker(alice).selectOption('python')
  await expect(picker(bob)).toHaveValue('python')
  await expect.poll(() => defColor(bob)).not.toBe(before)
  expect(await defColor(alice)).toBe(await defColor(bob))
  await snap(alice, 'two-windows-alice')
  await snap(bob, 'two-windows-bob')

  await picker(bob).selectOption('plaintext')
  await expect(picker(alice)).toHaveValue('plaintext')

  // Someone opening the link later gets the room's language, not the default.
  const carol = await (await browser.newContext()).newPage()
  await carol.goto(alice.url())
  await expect(picker(carol)).toHaveValue('plaintext')
  await expect(editor(carol)).toHaveText('def greet(): return 1')
})

test('copy link puts the pad URL on the clipboard', async ({ browser }) => {
  const { alice } = await openTwoWindows(browser)

  await alice.getByRole('button', { name: 'Copy link' }).click()
  await expect(alice.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await alice.evaluate(() => navigator.clipboard.readText())).toBe(alice.url())
})

test('a refresh brings the document back from the server', async ({ browser }) => {
  const { alice, bob } = await openTwoWindows(browser)

  await typeInto(alice, 'still here after refresh')
  await expect(editor(bob)).toHaveText('still here after refresh')
  await bob.reload()
  await expect(editor(bob)).toHaveText('still here after refresh')
})

test('undo only undoes your own edits', async ({ browser }) => {
  const { alice, bob } = await openTwoWindows(browser)

  await typeInto(alice, 'alice ')
  await expect(editor(bob)).toHaveText('alice')
  await bob.keyboard.press('ControlOrMeta+End')
  await typeInto(bob, 'bob')
  await expect(editor(alice)).toHaveText('alice bob')

  await alice.keyboard.press('ControlOrMeta+z')
  await expect(editor(alice)).toHaveText('bob')
  await expect(editor(bob)).toHaveText('bob')
})

test('an invalid pad link shows a not-found page', async ({ page }) => {
  await page.goto('/pad/NOPE!')
  await expect(page.getByRole('heading', { name: 'No pad here' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to PairPad' }).click()
  await expect(page.getByRole('button', { name: 'New pad' })).toBeVisible()
})
