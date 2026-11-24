import frappe
from frappe import _

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in to check in."), frappe.PermissionError)

    context.no_breadcrumbs = 1
    context.show_sidebar = False

    emp = frappe.db.get_value(
        "Employee",
        {"user_id": frappe.session.user, "status": "Active"},
        ["name", "employee_name"],
        as_dict=True,
    )
    if not emp:
        context.error = _("No active Employee record is linked to your login.")
        return context

    last = frappe.db.get_value(
        "Employee Checkin", {"employee": emp.name}, "log_type", order_by="time desc"
    )
    context.employee_name = emp.employee_name
    context.next_action = "OUT" if last == "IN" else "IN"
    context.csrf_token = frappe.sessions.get_csrf_token()
    return context
