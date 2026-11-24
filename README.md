# Employee Attendance Customization (Selfie Check-In for HRMS)

Makes a **live selfie mandatory** for Check In and Check Out in Frappe HRMS.
Employees keep using the normal Check In / Check Out button in the HRMS mobile
app (`/hrms`). It opens a camera screen with a face guide, and the selfie is
stored as a private file attached to the Employee Checkin.

## How it works

The app has two parts:

1. **The app itself** (installed with bench). It adds the server rule that
   rejects any check-in without a selfie, and stores selfies as private files.
2. **The HRMS camera screen** (installed with `install_hrms_patch.sh`). It
   patches one HRMS file (`CheckInPanel.vue`) so the normal Check In button
   opens the camera.

**You need both parts.** If you install only part 1, the HRMS Check In button
will fail with "A selfie is required". If that happens, either run the patch
script (below) or have employees use the standalone page `/selfie-checkin`.

## Requirements

- Frappe 15 and HRMS 15.x (tested on Frappe 15.126.0, ERPNext 15.124.5, HRMS 15.64.8)
- Self-hosted bench with shell access (the patch step modifies HRMS)
- **HTTPS** on your site. Browsers block camera access on plain HTTP (except localhost).
- Node and yarn (already present on a normal bench)

## Install (recommended: HRMS camera screen)

Run these in order. Replace `your-site` with your site name.

    cd ~/frappe-bench
    bench get-app https://github.com/suhana-3311/employee_attendance_customization --branch main
    bench --site your-site install-app employee_attendance_customization
    bench --site your-site migrate

    cd apps/employee_attendance_customization
    ./install_hrms_patch.sh --dry-run
    ./install_hrms_patch.sh

    cd ~/frappe-bench
    bench --site your-site clear-cache
    bench restart

Notes:

- `--dry-run` only checks that the patch fits your HRMS version. It changes nothing.
- `install_hrms_patch.sh` applies the patch, adds the MediaPipe dependency, runs yarn and rebuilds HRMS. It can be run again safely.
- After the install, hard-refresh the HRMS app (Ctrl+Shift+R).

## Alternative: standalone page (no HRMS changes)

If you do not want to change HRMS files, skip the patch script. Employees open
`https://your-site/selfie-checkin` instead and check in from there. The normal
HRMS Check In button will not work in this mode, because the server requires a selfie.

## After an HRMS upgrade

HRMS upgrades can overwrite the patched file. After each upgrade run
`./install_hrms_patch.sh` again. If the patch no longer fits the new HRMS
version, the script stops and changes nothing.

## Uninstall

    cd ~/frappe-bench/apps/employee_attendance_customization
    ./uninstall_hrms_patch.sh
    cd ~/frappe-bench
    bench --site your-site uninstall-app employee_attendance_customization
    bench restart

## What it checks

- Live camera only (no gallery or file upload).
- On-device guidance: face inside the circle, distance, eyes open, head straight, no hands in frame, sharp image.
- The server sets the check-in time, validates the image (JPEG/PNG, max 5 MB) and stores it as a private File.
- A check-in without a selfie is rejected by the server.
- Entries that carry a `device_id` (biometric devices) are exempt only when created by System Manager or HR Manager.

## Privacy

Selfies are personal data. Consent, retention and deletion are the employer's
responsibility under the laws that apply to you. Selfies are private files and
are visible only to users with permission on the Employee Checkin.

## Limitations

- This is a photo requirement, not face recognition and not proof of identity or liveness.
- No GPS or geofencing.
- A hand pressed against the lens before the face is detected may not be caught.
- The patch targets HRMS 15.x only and changes `CheckInPanel.vue`.
- Because it modifies HRMS, it works on self-hosted benches only (not Frappe Cloud).
- In Docker setups, the patched HRMS files live inside the container or image, so re-run the patch script after rebuilding.

## License

MIT. See `license.txt`. Third-party components are listed in `THIRD_PARTY_NOTICES.md`.
