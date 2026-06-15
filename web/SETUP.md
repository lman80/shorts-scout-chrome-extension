# Shorts Scout — Website (cloud-synced board)

This is the watchlist board as a standalone website. Your data lives in **your own
free Firebase project** and syncs across every device. Sign in with Google to access
it anywhere — no extension required (the extension just adds to the same cloud).

**Cost: $0.** Firebase's free "Spark" plan and the YouTube Data API free tier cover
personal use with no credit card and no subscription.

## Files
- `index.html` — the app (generated from the extension board by `build.py`)
- `cloud-app.js` — Firebase init, Google sign-in, and the `chrome.*` shim (Firestore + YouTube API)
- `firebase-config.js` — **you paste your Firebase config here**
- `firestore.rules` — security rules (paste into Firebase)
- `watchlist.js`, `marked.min.js` — copied from the extension (don't edit here; edit in the extension and re-run `build.py`)

## One-time setup (~10 minutes)

### 1. Create a free Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (any name, e.g. "shorts-scout"). Disable Google Analytics if asked — not needed.

### 2. Add a Web app + paste config
1. In the project, click the **`</>` (Web)** icon → register an app (any nickname).
2. Copy the `firebaseConfig` object it shows.
3. Paste those values into **`firebase-config.js`** (replacing the `REPLACE_ME`s).

### 3. Turn on Google sign-in
1. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**

### 4. Create the database + rules
1. **Build → Firestore Database → Create database** → Start in **production mode** → pick a location → Enable.
2. Open the **Rules** tab, paste the contents of **`firestore.rules`**, and **Publish**.

### 5. Put it online (pick one — all free)
- **Firebase Hosting** (recommended, auto-allows sign-in). `firebase.json` is already
  created, so no interactive `firebase init` is needed — just:
  ```
  npm install -g firebase-tools
  firebase login
  cd web && firebase deploy --only hosting --project <your-project-id>
  ```
  (`<your-project-id>` is the `projectId` from your Firebase config.)
  Your site is at `https://<project>.web.app`.
- **Netlify**: drag the `web/` folder onto <https://app.netlify.com/drop>. Then in Firebase →
  Authentication → Settings → **Authorized domains**, add your `*.netlify.app` domain.
- **Cloudflare Pages / Vercel / GitHub Pages**: deploy this folder as a static site, then add
  that domain to Firebase Authorized domains.

### 6. First run
1. Open your site → **Sign in with Google**.
2. Click **🔑 API key** (bottom-right) → paste your YouTube Data API v3 key (the same one the
   extension uses) so Refresh / Recent shorts / Analytics work.
3. Click **⬆ Import** → in the extension, use **⋯ More → Export**, open the `.md`, and paste the
   block under "Raw data" (or the whole file's JSON) to migrate your existing board into the cloud.

## Notes
- **Notebook screenshots** stay on the device that pasted them for now (a single Firestore
  document caps at 1 MB, too small for images). The notebook *text* syncs. Moving images to
  Firebase Storage so they sync too is a easy follow-up.
- **Extension → cloud sync** (so saving a channel while watching Shorts lands here automatically)
  is the next step, wired to this same Firebase project.
- Re-run `python3 build.py` whenever the extension's `watchlist.html` / `watchlist.js` change, then redeploy.
