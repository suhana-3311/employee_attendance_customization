import base64
import binascii
from io import BytesIO

import frappe
from frappe import _
from frappe.utils import now_datetime

MAX_SELFIE_BYTES = 5 * 1024 * 1024

# Attendance-device entries (device_id set) are exempt, but only when created
# by these roles, so employees cannot bypass the selfie rule through the API.
DEVICE_EXEMPT_ROLES = {"System Manager", "HR Manager"}


def validate_employee_checkin(doc, method=None):
    if doc.log_type not in ("IN", "OUT"):
        return

    if doc.device_id and DEVICE_EXEMPT_ROLES.intersection(frappe.get_roles()):
        return

    if not doc.custom_selfie:
        frappe.throw(_("A selfie is required for Check In and Check Out."))


@frappe.whitelist(methods=["POST"])
def create_checkin_with_selfie(selfie_base64, log_type="IN"):
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in before checking in."), frappe.PermissionError)

    if log_type not in ("IN", "OUT"):
        frappe.throw(_("Invalid log type."))

    employee = frappe.db.get_value(
        "Employee",
        {"user_id": frappe.session.user, "status": "Active"},
        "name",
    )
    if not employee:
        frappe.throw(_("No active Employee record is linked to your login."))

    try:
        image_content = base64.b64decode(selfie_base64, validate=True)
    except (binascii.Error, ValueError):
        frappe.throw(_("Invalid selfie image."))

    if not image_content:
        frappe.throw(_("Selfie image is empty."))

    if len(image_content) > MAX_SELFIE_BYTES:
        frappe.throw(_("Selfie image must be smaller than 5 MB."))

    try:
        from PIL import Image

        image = Image.open(BytesIO(image_content))
        image.verify()

        if image.format not in ("JPEG", "PNG"):
            frappe.throw(_("Only JPEG and PNG selfies are allowed."))

        extension = "jpg" if image.format == "JPEG" else "png"
    except frappe.ValidationError:
        raise
    except Exception:
        frappe.throw(_("The captured selfie is not a valid image."))

    file_doc = frappe.get_doc(
        {
            "doctype": "File",
            "file_name": f"checkin-selfie-{frappe.generate_hash(length=10)}.{extension}",
            "content": image_content,
            "is_private": 1,
        }
    ).insert(ignore_permissions=True)

    try:
        checkin = frappe.get_doc(
            {
                "doctype": "Employee Checkin",
                "employee": employee,
                "log_type": log_type,
                "time": now_datetime(),  # server time, not client time
                "custom_selfie": file_doc.file_url,
            }
        ).insert()
    except Exception:
        frappe.delete_doc("File", file_doc.name, ignore_permissions=True, force=True)
        raise

    # Attach the selfie to the check-in so HR users who can read the record can open it
    frappe.db.set_value(
        "File",
        file_doc.name,
        {
            "attached_to_doctype": "Employee Checkin",
            "attached_to_name": checkin.name,
            "attached_to_field": "custom_selfie",
        },
        update_modified=False,
    )

    checkin.add_comment(
        "Comment",
        f'<p>{log_type.title()} selfie captured: '
        f'<a href="{file_doc.file_url}">View Selfie</a></p>',
    )

    return {
        "name": checkin.name,
        "custom_selfie": file_doc.file_url,
        "log_type": log_type,
        "message": _("{0} successful").format(log_type.title()),
    }


@frappe.whitelist()
def get_checkin_state():
    """Employee name and next action (IN/OUT) for the logged-in user."""
    if frappe.session.user == "Guest":
        frappe.throw("Please log in to check in.", frappe.PermissionError)

    emp = frappe.db.get_value(
        "Employee",
        {"user_id": frappe.session.user, "status": "Active"},
        ["name", "employee_name"],
        as_dict=True,
    )
    if not emp:
        frappe.throw("No active Employee record is linked to your login.")

    last = frappe.db.get_value(
        "Employee Checkin", {"employee": emp.name}, "log_type", order_by="time desc"
    )
    return {
        "employee_name": emp.employee_name,
        "next_action": "OUT" if last == "IN" else "IN",
    }
