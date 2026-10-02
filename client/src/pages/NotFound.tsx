import { onLinkClick } from '../router'

export function NotFound() {
  return (
    <main className="landing">
      <h1>No pad here</h1>
      <p className="tagline">
        This link doesn't point to a pad. Check that the whole link was copied, or start a new one.
      </p>
      <a className="button button-primary" href="/" onClick={onLinkClick}>
        Go to PairPad
      </a>
    </main>
  )
}
