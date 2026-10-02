import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test'
import WebSocket from 'ws'

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
    copy.querySelectorAll('.cm-remoteCaret, .cm-placeholder').forEach((node) => node.remove())
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

    const caret = bob.locator('.cm-remoteCaret')
    await expect(caret).toHaveCount(1)
    await expect(caret).toHaveCSS('border-left-color', 'rgb(244, 114, 182)')
    await expect(bob.locator('.cm-remoteCaretTag')).toHaveText('Ada')
    // Alice sees Bob's cursor, never a remote-style cursor for herself.
    await expect(alice.locator('.cm-remoteCaretTag')).toHaveCount(1)
    await expect(alice.locator('.cm-remoteCaretTag')).not.toHaveText('Ada')

    await alice.keyboard.press('ControlOrMeta+a')
    await expect(bob.locator('.cm-remoteSelection').first()).toBeVisible()
    await snap(bob, 'presence-bob')
    await openPresence(bob)
    await snap(bob, 'presence-bob-menu')

    await alice.close()
    await expect(caret).toHaveCount(0)
  })

  test('the name tag on a remote cursor fades out and returns when they type again', async ({ browser }) => {
    const { alice, bob } = await openTwoWindows(browser)
    const tagOpacity = () =>
      bob.locator('.cm-remoteCaretTag').evaluate((tag) => Number(getComputedStyle(tag).opacity))

    await typeInto(alice, 'first line')
    await expectPadText(bob, 'first line')
    expect(await tagOpacity()).toBeGreaterThan(0.9)
    // Once it has faded it no longer hides the text above the cursor.
    await expect.poll(tagOpacity, { timeout: 5000 }).toBe(0)

    await alice.keyboard.type(' and more')
    await expectPadText(bob, 'first line and more')
    expect(await tagOpacity()).toBeGreaterThan(0.9)
    await expect.poll(tagOpacity, { timeout: 5000 }).toBe(0)

    // Bob typing on the same line does not make Alice's tag flash back.
    await editor(bob).click()
    await bob.keyboard.press('ControlOrMeta+Home')
    await bob.keyboard.type('bob was here ')
    await expectPadText(alice, 'bob was here first line and more')
    expect(await tagOpacity()).toBe(0)

    // Moving without typing counts as activity too.
    await alice.keyboard.press('ControlOrMeta+Home')
    await expect.poll(tagOpacity).toBeGreaterThan(0.9)
  })

  test('a rename updates the name tag on your cursor for others', async ({ browser }) => {
    const { alice, bob } = await openTwoWindows(browser)
    await typeInto(alice, 'hello')
    await expectPadText(bob, 'hello')
    const tag = bob.locator('.cm-remoteCaretTag')
    await expect(tag).toHaveCount(1)

    await openPresence(alice)
    await myName(alice).fill('Grace Hopper')
    await expect(tag).toHaveText('Grace Hopper')
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

test.describe('reliability', () => {
  const badge = (page: Page) => page.locator('.status')

  /** Lets a test cut and restore one page's connection to the server. Call before navigating. */
  async function networkSwitch(page: Page) {
    let down = false
    const open: Array<[WebSocketRoute, WebSocketRoute]> = []
    await page.routeWebSocket(/\/ws\//, (ws) => {
      if (down) {
        void ws.close()
        return
      }
      open.push([ws, ws.connectToServer()])
    })
    return {
      async cut() {
        down = true
        for (const [pageSide, serverSide] of open.splice(0)) {
          await pageSide.close()
          await serverSide.close()
        }
      },
      restore() {
        down = false
      },
    }
  }

  async function openWithSwitch(browser: Browser) {
    const alice = await (await browser.newContext()).newPage()
    const network = await networkSwitch(alice)
    await alice.goto('/')
    await alice.getByRole('button', { name: 'New pad' }).click()
    await expect(alice).toHaveURL(/\/pad\//)
    const bob = await (await browser.newContext()).newPage()
    await bob.goto(alice.url())
    await expect(badge(alice)).toHaveText('Connected')
    await expect(badge(bob)).toHaveText('Connected')
    return { alice, bob, network }
  }

  test('edits made while disconnected merge when the connection returns', async ({ browser }) => {
    const { alice, bob, network } = await openWithSwitch(browser)
    await typeInto(alice, 'shared line')
    await expectPadText(bob, 'shared line')

    await network.cut()
    await expect(badge(alice)).toHaveText('Reconnecting')
    await expect(bob.getByRole('button', { name: '1 person here' })).toBeVisible()
    await expect(alice.getByRole('button', { name: '1 person here' })).toBeVisible()

    // Both keep typing; neither sees the other for now.
    await alice.keyboard.type(' + alice offline')
    await editor(bob).click()
    await bob.keyboard.press('ControlOrMeta+Home')
    await bob.keyboard.type('bob online + ')
    await expectPadText(alice, 'shared line + alice offline')
    await expectPadText(bob, 'bob online + shared line')
    await snap(alice, 'status-reconnecting')

    network.restore()
    await expect(badge(alice)).toHaveText('Connected')
    await expectPadText(alice, 'bob online + shared line + alice offline')
    await expectPadText(bob, 'bob online + shared line + alice offline')
    await expect(alice.getByRole('button', { name: '2 people here' })).toBeVisible()
    await expect(bob.getByRole('button', { name: '2 people here' })).toBeVisible()
  })

  test('shows Offline when the browser has no network, and recovers', async ({ browser }) => {
    const { alice, bob, network } = await openWithSwitch(browser)
    await alice.context().setOffline(true)
    await network.cut()
    await expect(badge(alice)).toHaveText('Offline')

    await typeInto(alice, 'written on a train')
    await snap(alice, 'status-offline')
    await alice.context().setOffline(false)
    network.restore()
    await expect(badge(alice)).toHaveText('Connected')
    await expectPadText(bob, 'written on a train')
  })

  test('goes from Reconnecting to Offline when the outage drags on', async ({ browser }) => {
    const { alice, network } = await openWithSwitch(browser)
    await network.cut()
    await expect(badge(alice)).toHaveText('Reconnecting')
    await expect(badge(alice)).toHaveText('Offline', { timeout: 12_000 })
    network.restore()
    await expect(badge(alice)).toHaveText('Connected')
  })

  test('warns before closing a tab that holds unsent edits', async ({ browser }) => {
    const { alice, network } = await openWithSwitch(browser)
    const warnsOnLeave = () =>
      alice.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })
    expect(await warnsOnLeave()).toBe(false)

    await network.cut()
    await expect(badge(alice)).toHaveText('Reconnecting')
    await typeInto(alice, 'not sent yet')
    await expect.poll(warnsOnLeave).toBe(true)

    network.restore()
    await expect(badge(alice)).toHaveText('Connected')
    await expect.poll(warnsOnLeave).toBe(false)
  })
})

test.describe('limits', () => {
  test('an 11th person sees that the pad is full and can join once someone leaves', async ({ page, baseURL }) => {
    const roomId = `full${Math.random().toString(36).slice(2, 8)}`
    const wsUrl = `${baseURL!.replace('http', 'ws')}/ws/${roomId}`
    const sockets = Array.from({ length: 10 }, () => new WebSocket(wsUrl))
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.once('open', resolve))))

    await page.goto(`/pad/${roomId}`)
    await expect(page.getByRole('heading', { name: 'This pad is full' })).toBeVisible()
    await expect(page.locator('.cm-content')).toHaveCount(0)
    await snap(page, 'room-full')

    // Still full: trying again lands on the same notice.
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { name: 'This pad is full' })).toBeVisible()

    sockets[0]!.close()
    await expect(async () => {
      await page.getByRole('button', { name: 'Try again' }).click({ timeout: 1000 })
      await expect(editor(page)).toBeVisible({ timeout: 1000 })
    }).toPass()
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible()
    for (const socket of sockets) socket.close()
  })

  test('the editor refuses text beyond the size limit but still lets you delete', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    await page.goto('/')
    await page.getByRole('button', { name: 'New pad' }).click()
    await expect(editor(page)).toBeVisible()
    const paste = async (lines: number) => {
      // Each line is 100 bytes including its line break.
      await page.evaluate((n) => navigator.clipboard.writeText(('x'.repeat(99) + '\n').repeat(n)), lines)
      await editor(page).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.press('ControlOrMeta+v')
    }
    const lastLineNumber = () => page.locator('.cm-lineNumbers .cm-gutterElement').last().innerText()
    const limitBanner = page.getByText('This pad is at its size limit')

    // 950 kB in one go: over the limit, so nothing is inserted.
    await paste(9_500)
    await expect(limitBanner).toBeVisible()
    await expect(page.locator('.cm-placeholder')).toBeVisible()

    // 800 kB fits.
    await paste(8_000)
    await expect.poll(lastLineNumber).toBe('8001')

    // Another 200 kB would not.
    await paste(2_000)
    await expect(limitBanner).toBeVisible()
    await snap(page, 'size-limit')
    await expect.poll(lastLineNumber).toBe('8001')

    // Small edits and deleting still work, and the pad stays connected.
    await page.keyboard.type('ok')
    await page.keyboard.press('Backspace')
    await expect(page.locator('.cm-activeLine')).toHaveText('o')
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible()
  })

  test('explains when the server refuses a change for size, and stops editing', async ({ page }) => {
    await page.routeWebSocket(/\/ws\//, async (ws) => {
      // Stand in for the server turning down an oversized update.
      await ws.close({ code: 4413, reason: 'document too large' })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'New pad' }).click()

    await expect(page.getByRole('alert')).toContainText('1 MB size limit')
    await expect(editor(page)).toHaveAttribute('contenteditable', 'false')
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
    await snap(page, 'too-large')
    // It does not keep hammering the server with reconnects.
    await expect(page.locator('.status')).toHaveCount(0)
  })
})

