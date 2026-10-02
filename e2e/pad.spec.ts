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

/** The document text as displayed, without the name tags drawn on remote cursors. */
function padText(page: Page): Promise<string> {
  return editor(page).evaluate((content) => {
    const copy = content.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.cm-ySelectionCaret, .cm-placeholder').forEach((node) => node.remove())
    return [...copy.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n')
  })
}

async function expectPadText(page: Page, expected: string | RegExp): Promise<void> {
  const assertion = expect.poll(() => padText(page))
  await (typeof expected === 'string' ? assertion.toBe(expected) : assertion.toMatch(expected))
}

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
  await expectPadText(bob, 'hello from alice')

  await editor(bob).click()
  await bob.keyboard.press('ControlOrMeta+End')
  await bob.keyboard.type(' and bob')
  await expectPadText(alice, 'hello from alice and bob')
  await expectPadText(bob, 'hello from alice and bob')
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
    .poll(async () => (await padText(alice)).length + (await padText(bob)).length)
    .toBe(count * 4)
  const text = await padText(alice)
  expect(await padText(bob)).toBe(text)
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
  await expectPadText(bob, 'def greet(): return 1')
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
  await expectPadText(carol, 'def greet(): return 1')
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
  await expectPadText(bob, 'still here after refresh')
  await bob.reload()
  await expectPadText(bob, 'still here after refresh')
})

test('undo only undoes your own edits', async ({ browser }) => {
  const { alice, bob } = await openTwoWindows(browser)

  await typeInto(alice, 'alice ')
  await expectPadText(bob, 'alice ')
  await editor(bob).click()
  await bob.keyboard.press('ControlOrMeta+End')
  await bob.keyboard.type('bob')
  await expectPadText(alice, 'alice bob')

  await alice.keyboard.press('ControlOrMeta+z')
  await expectPadText(alice, 'bob')
  await expectPadText(bob, 'bob')
})

test('an invalid pad link shows a not-found page', async ({ page }) => {
  await page.goto('/pad/NOPE!')
  await expect(page.getByRole('heading', { name: 'No pad here' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to PairPad' }).click()
  await expect(page.getByRole('button', { name: 'New pad' })).toBeVisible()
})

test.describe('presence', () => {
  const openPresence = (page: Page) => page.getByRole('button', { name: /(person|people) here/ }).click()
  const names = (page: Page) => page.locator('.presence-name')
  const myName = (page: Page) => page.getByLabel('Your name')

  test('lists who is here and updates as people join and leave', async ({ browser }) => {
    const { alice, bob } = await openTwoWindows(browser)
    await expect(alice.getByRole('button', { name: '2 people here' })).toBeVisible()
    await expect(bob.getByRole('button', { name: '2 people here' })).toBeVisible()

    await openPresence(alice)
    await openPresence(bob)
    const aliceName = await myName(alice).inputValue()
    const bobName = await myName(bob).inputValue()
    expect(aliceName).not.toBe('')
    // Yourself first, marked "you"; then everyone else.
    await expect(names(alice)).toHaveText([aliceName, bobName])
    await expect(names(bob)).toHaveText([bobName, aliceName])
    await expect(alice.locator('.presence-list li').first()).toContainText('you')

    const carol = await (await browser.newContext()).newPage()
    await carol.goto(alice.url())
    await expect(names(alice)).toHaveCount(3)
    await expect(names(bob)).toHaveCount(3)

    await carol.close()
    await bob.close()
    await expect(names(alice)).toHaveText([aliceName])
    await expect(alice.getByRole('button', { name: '1 person here' })).toBeVisible()
  })

  test('renaming and recoloring yourself shows up for others and is remembered', async ({ browser }) => {
    const { alice, bob } = await openTwoWindows(browser)
    await openPresence(alice)
    await openPresence(bob)

    await myName(alice).fill('Ada Lovelace')
    await alice.getByRole('radio', { name: 'Green' }).click()
    await expect(names(bob).nth(1)).toHaveText('Ada Lovelace')
    const adaAvatar = bob.locator('.presence-list li').nth(1).locator('.avatar')
    await expect(adaAvatar).toHaveText('AL')
    await expect(adaAvatar).toHaveCSS('background-color', 'rgb(52, 211, 153)')

    // Clearing the field does not blank your name for everyone else.
    await myName(alice).fill('')
    await myName(alice).blur()
    await expect(myName(alice)).toHaveValue('Ada Lovelace')
    await expect(names(bob).nth(1)).toHaveText('Ada Lovelace')

    await alice.reload()
    await openPresence(alice)
    await expect(myName(alice)).toHaveValue('Ada Lovelace')
    await expect(alice.getByRole('radio', { name: 'Green' })).toBeChecked()
  })

  test('shows the other person\'s cursor and selection in their color', async ({ browser }) => {
    const { alice, bob } = await openTwoWindows(browser)
    await openPresence(alice)
    await myName(alice).fill('Ada')
    await alice.getByRole('radio', { name: 'Pink' }).click()
    await alice.keyboard.press('Escape')

    await typeInto(alice, 'const answer = 42')
    await expectPadText(bob, 'const answer = 42')

    const caret = bob.locator('.cm-ySelectionCaret')
    await expect(caret).toHaveCount(1)
    await expect(caret).toHaveCSS('border-left-color', 'rgb(244, 114, 182)')
    await expect(bob.locator('.cm-ySelectionInfo')).toHaveText('Ada')
    // Alice sees Bob's cursor, never a remote-style cursor for herself.
    await expect(alice.locator('.cm-ySelectionInfo')).toHaveCount(1)
    await expect(alice.locator('.cm-ySelectionInfo')).not.toHaveText('Ada')

    await alice.keyboard.press('ControlOrMeta+a')
    await expect(bob.locator('.cm-ySelection').first()).toBeVisible()
    await snap(bob, 'presence-bob')
    await openPresence(bob)
    await snap(bob, 'presence-bob-menu')

    await alice.close()
    await expect(caret).toHaveCount(0)
  })

  test('two people who were given the same random color end up with different ones', async ({ browser }) => {
    const pages: Page[] = []
    for (const name of ['First', 'Second']) {
      const context = await browser.newContext()
      await context.addInitScript((identity) => {
        if (!window.localStorage.getItem('pairpad:identity')) {
          window.localStorage.setItem('pairpad:identity', JSON.stringify(identity))
        }
      }, { name, color: '#f87171', colorPicked: false })
      pages.push(await context.newPage())
    }
    const [first, second] = pages as [Page, Page]
    await first.goto('/')
    await first.getByRole('button', { name: 'New pad' }).click()
    await expect(first).toHaveURL(/\/pad\//)
    await second.goto(first.url())

    const colors = (page: Page) =>
      page.locator('.presence-toggle .avatar').evaluateAll((avatars) =>
        avatars.map((avatar) => getComputedStyle(avatar).backgroundColor),
      )
    for (const page of [first, second]) {
      await expect.poll(async () => new Set(await colors(page)).size).toBe(2)
    }
    // Both windows agree on who has which color.
    expect((await colors(first)).sort()).toEqual((await colors(second)).sort())
  })

  test('a color you picked yourself is kept even if someone else has it', async ({ browser }) => {
    const { alice, bob } = await openTwoWindows(browser)
    await openPresence(alice)
    await alice.getByRole('radio', { name: 'Cyan' }).click()
    await openPresence(bob)
    await bob.getByRole('radio', { name: 'Cyan' }).click()

    for (const page of [alice, bob]) {
      const avatars = page.locator('.presence-list .avatar')
      await expect(avatars.nth(0)).toHaveCSS('background-color', 'rgb(34, 211, 238)')
      await expect(avatars.nth(1)).toHaveCSS('background-color', 'rgb(34, 211, 238)')
    }
  })
})
