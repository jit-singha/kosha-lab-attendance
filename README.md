# Kosha Lab Attendance Tracker

A clean, professional daily attendance web app for Kosha Lab, with light and dark themes.

## Features
- **Accounts & admin access**: everyone signs in with email and password. Admins can add members, give or remove admin access, and remove people. The owner account is always an admin.
- **Check in / check out**: each person checks themselves in, with a live clock.
- **Late login detection**: configurable shift start time and grace period; shows how many minutes late. Anyone checking in late types a reason, which shows next to their Late status for HR and admins and in the CSV export.
- **Day and night shifts**: separate start times for each shift; members choose Day or Night on the Check In page (remembered for next time), and admins can also rotate everyone Day ↔ Night with one click (or change people individually). Night-shift check-ins and check-outs after midnight count towards the night the shift started. The Dashboard filters by department and shift, and each check-in records the shift it was worked on.
- **Precise location capture**: GPS is required to check in. The app samples GPS until it gets an accurate fix, then records the full street address, exact coordinates (6 decimals) and accuracy in metres. Each entry opens on an embedded map with a pin, or in Google Maps.
- **Laptop take-home log**: members request to take a laptop home (asset ID, dates, reason). Admins approve or reject, then mark it returned. Laptops not back by the return date show as **Overdue**.
- **Roles and departments**: Member, Operator or Admin, and a department (Operations, IT, Data Analysis, HR, Finance). People choose their department when they create an account (existing accounts are asked once); after that only an admin can change it in **Team & Access**. Everyone in Operations can log devices; the optional Operator role is always in Operations.
- **Devices (Operations department and admins; IT can view)**: the IT department sees all deployments, damage reports and summaries and can export them, and marks each deployment **Confirmed & sent** or **Confirmed & received** (admins can too); IT cannot change the records themselves. Data Analysis, HR and Finance have no access. operators log daily device deployments (date, the operator who took the devices, a mixed count of 03W / Pi / Cubic devices in one entry, extra items taken (a Yes / No question each for extra SD cards, flood lights, power cables, OTG and Samsung / Oppo phones, with how many when Yes, plus any other items with their type and number), deployment location with optional GPS pin, notes) and damage reports (how many of each type are damaged, device IDs, the issue, and a status: Reported / Under repair / Repaired / Scrapped). Daily or all-time summary by device type, edit and delete own records (admins can edit any), and CSV export for both.
- **Team Attendance (HR department and admins)**: everyone's attendance by **day** or **month**. HR can change any day to Present, Absent, Week off, Casual leave, Sick leave or Paid leave (the original check-in is kept and the change shows who made it), approve or reject leave requests, and **download the whole month** as one CSV with each person's days present, late, absent and on each leave type, plus every day's status. HR can't change their own attendance or approve their own leave; an admin can.
- **Leave (everyone)**: on **My Attendance**, people request a week off, casual, sick or paid leave, see their requests, and see how many approved days of each they have taken this year.
- **Dashboard (admins)**: on-time / late / absent per day, attendance log with locations, all-time late leaderboard, CSV export.
- **My Attendance (everyone)**: personal history, late count, average check-in time and leave.

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
