# Mohr-ry Match

A private, remote Secret Santa website for families. It uses a free Netlify address, Netlify Functions, and Netlify Blobs—no custom domain or email service is required.

## How it works

1. The organizer creates the participant list and couple exclusions.
2. The site creates one family join link and a separate private organizer URL.
3. Each person opens the family link, claims their own name, creates a PIN or passphrase, and can add up to four gift preferences with one optional reference photo under each preference.
4. Once everyone has joined, the organizer starts the draw.
5. Participants revisit the family link on the same device, or sign in with their name and PIN elsewhere, to see only their own recipient and that recipient's preferences.

The organizer dashboard shows join status but never returns assignments.
Before drawing, the organizer can exclude anyone who opts out and restore them if plans change. Excluded people neither give nor receive a name, and only included participants must finish joining.

The organizer can also reset the event while keeping the same event name, roster, couple rules, organizer link and family link. Resetting clears all claims, PINs, sessions, preferences, photos, opt-outs and assignments, so everyone must join again.

The organizer dashboard can permanently delete its current event and all associated data. The homepage also has a deployment-owner maintenance panel that can erase every event in both the current and legacy storage namespaces.

## Deploy without a domain

The site can use the free address Netlify assigns, such as:

`https://your-site-name.netlify.app`

### GitHub and Netlify

1. Create an empty GitHub repository.
2. In this folder, run:

```powershell
git init
git add .
git commit -m "Build private Secret Santa site"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

3. Sign in to <https://app.netlify.com>.
4. Choose **Add new project → Import an existing project**.
5. Select GitHub and choose the repository.
6. Leave the build command blank and publish directory as `.`.
7. Deploy.

Future `git push` commands update the website. Git itself does not send email; participants use the shared family link.

Normal event use requires no environment variables or external API keys.

To enable the global **Clear all events** maintenance action, add this private Netlify environment variable:

- `DATA_CLEANUP_KEY`: a long, unique passphrase known only to the deployment owner

The passphrase is checked by the server and must never be committed to this repository.

## Local development

Install dependencies:

```powershell
npm install
```

Run through Netlify's local environment:

```powershell
npx netlify-cli dev
```

Opening `index.html` directly is not sufficient because the private draw requires the server function and persistent storage.

## Privacy and security

- PINs are processed with `scrypt` and only salted hashes are stored.
- Browser sessions use random 256-bit tokens; only their hashes are stored.
- The organizer URL uses a separate random 256-bit token in the URL fragment.
- Assignments are generated with cryptographically secure randomness.
- Couple exclusions apply in both directions.
- The organizer can exclude or restore participants only before the draw; at least three included people are required.
- Resetting requires a typed confirmation and invalidates all previous participant sessions and assignments.
- Deleting an event permanently removes its roster and all associated records.
- Clearing all events requires the server-side `DATA_CLEANUP_KEY` and also removes data saved under the site's former `merry-match-events` namespace.
- The organizer API never returns assignments or participant preferences.
- Written preferences and reference photos are optional.
- Each preference photo is limited to 1 MB. Photos remain behind participant-session authorization; no public image URL is created.
- Requests are rate-limited by IP address.

Keep the organizer URL private and bookmark it. Anyone possessing that complete URL can operate the organizer dashboard.

The owner of the Netlify account can technically inspect stored blobs. Preventing the infrastructure owner from seeing backend data would require end-to-end encryption or a trusted third-party service. Also, without email or identity verification, the family relies on participants claiming only their own names; once claimed, a name is locked behind its PIN.
