# Kosha Lab Attendance Tracker

A sleek, neon-styled daily attendance web app for Kosha Lab.

Made by **Jit Singh**.

## Features
- **Accounts & admin access**: everyone signs in with email and password. Admins can add members, give or remove admin access, and remove people. The owner account is always an admin.
- **Check in / check out**: each person checks themselves in, with a live clock.
- **Late login detection**: configurable shift start time and grace period; shows how many minutes late.
- **Precise location capture**: GPS is required to check in. The app samples GPS until it gets an accurate fix, then records the full street address, exact coordinates (6 decimals) and accuracy in metres. Each entry opens on an embedded map with a pin, or in Google Maps.
- **Laptop take-home log**: members request to take a laptop home (asset ID, dates, reason). Admins approve or reject, then mark it returned. Laptops not back by the return date show as **Overdue**.
- **Roles**: Member, Operator or Admin, chosen per person in **Team & Access**.
- **Devices (operators and admins)**: operators log daily device deployments (date, the operator who took the devices, a mixed count of 03W / Pi / Cubic devices in one entry, deployment location with optional GPS pin, notes) and damage reports (how many of each type are damaged, device IDs, the issue, and a status: Reported / Under repair / Repaired / Scrapped). Daily or all-time summary by device type, edit and delete own records (admins can edit any), and CSV export for both.
- **Dashboard (admins)**: on-time / late / absent per day, attendance log with locations, all-time late leaderboard, CSV export.
- **My Attendance (members)**: personal history, late count and average check-in time.

## Demo mode
While `firebase-config.js` is empty, the app runs in **demo mode**: everything is stored in the current browser only, and the first account created becomes the admin. Use it to try the app.

## Set up Firebase (shared data across all devices)
1. Go to <https://console.firebase.google.com>, then **Add project** and name it (e.g. `kosha-lab-attendance`). Google Analytics can be turned off.
2. **Build → Authentication → Get started → Email/Password → Enable**.
3. **Build → Firestore Database → Create database**, choose a region near you, and start in **production mode**.
4. In Firestore, open the **Rules** tab, paste the contents of `firestore.rules`, replace `OWNER_EMAIL_HERE` with your email, then click **Publish**.
5. **Project settings (gear) → Your apps → Web (`</>`)**. Register the app, then copy the `firebaseConfig` values into `firebase-config.js`. Set `OWNER_EMAIL` to the same email as in step 4.
6. **Authentication → Settings → Authorized domains**: add `<your-github-username>.github.io`.
7. Open the site and **create an account with the owner email**. That account is the admin. Add your team from **Team & Access**.

> The Firebase web config is not a secret; it is safe in a public repo. Access is protected by the Firestore rules.

## Run
It's a static site: host it on GitHub Pages, or serve the folder locally (e.g. `python -m http.server`).
Location access needs HTTPS (or localhost).
