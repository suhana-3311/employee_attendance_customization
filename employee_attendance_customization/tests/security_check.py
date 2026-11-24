import base64
import frappe

PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def _try(label, fn, expect_fail=True):
    try:
        fn()
        ok, res = (not expect_fail), "no error"
    except Exception as e:
        ok, res = expect_fail, f"{type(e).__name__}: {str(e)[:90]}"
    print(("PASS" if ok else "FAIL"), "-", label, "->", res)
    frappe.db.rollback()


def _pick_users():
    emp_users = {e.user_id for e in frappe.get_all(
        "Employee", filters={"user_id": ["is", "set"]}, fields=["user_id"])}
    plain = nonemp = None
    for u in frappe.get_all("User", filters={"enabled": 1, "user_type": "System User"}, pluck="name"):
        if u in ("Administrator", "Guest"):
            continue
        roles = set(frappe.get_roles(u))
        if u in emp_users and not (roles & {"System Manager", "HR Manager"}) and not plain:
            plain = u
        if u not in emp_users and not nonemp:
            nonemp = u
    return plain, nonemp


def run():
    from employee_attendance_customization.attendance import create_checkin_with_selfie as make
    plain, nonemp = _pick_users()
    print("employee test user:", plain, "| non-employee user:", nonemp)

    frappe.set_user("Guest")
    _try("Guest cannot check in", lambda: make(PNG, "IN"))

    if plain:
        frappe.set_user(plain)
        emp = frappe.db.get_value("Employee", {"user_id": plain}, "name")
        _try("No selfie rejected", lambda: make("", "IN"))
        _try("Not an image rejected",
             lambda: make(base64.b64encode(b"hello world").decode(), "IN"))
        big = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * (6 * 1024 * 1024)).decode()
        _try("Oversized image rejected", lambda: make(big, "IN"))
        _try("device_id bypass blocked", lambda: frappe.get_doc({
            "doctype": "Employee Checkin", "employee": emp,
            "log_type": "IN", "device_id": "fake-device"}).insert())
        _try("Valid selfie accepted", lambda: make(PNG, "IN"), expect_fail=False)
    else:
        print("SKIPPED employee tests: no plain employee user found")

    if nonemp:
        frappe.set_user(nonemp)
        _try("User without Employee rejected", lambda: make(PNG, "IN"))

    frappe.set_user("Administrator")


def run_no_employee():
    from employee_attendance_customization.attendance import create_checkin_with_selfie as make
    frappe.set_user("Administrator")
    emp = frappe.db.get_value("Employee", {"user_id": "Administrator"}, "name")
    if emp:
        print("SKIPPED: Administrator has an Employee record:", emp)
        return
    _try("User without Employee rejected", lambda: make(PNG, "IN"))
