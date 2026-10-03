import { getUsers, updateUserRole, deleteUser, updateUserProfile } from "@/actions/inspections";
import { getUser } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { setRepCommissionRate } from "@/actions/commissions";
import CreatePmForm from "@/components/create-pm-form";
import { toggleLeadAccess } from "@/actions/leads";
import { toggleTimeclock, setHourlyRate } from "@/actions/timeclock";
import { toggleDailyEmail } from "@/actions/notifications";
import { formatDate } from "@/lib/utils";
import DeleteUserButton from "@/components/delete-user-button";
import InviteRepButton from "@/components/invite-rep-button";
import UserActionsMenu from "@/components/user-actions-menu";

function isOnline(lastSeenAt: Date | string | null): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt);
  const now = new Date();
  return now.getTime() - seen.getTime() < 2 * 60 * 1000;
}

function timeAgo(date: Date | string | null): string {
  if (!date) return "Never";
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function AdminUsersPage() {
  const authUser = await getUser();
  const profile = authUser ? await prisma.profile.findUnique({ where: { id: authUser.id } }) : null;
  const users = await getUsers();

  const teamMembers = users.filter((u) => u.role === "ADMIN" || u.role === "REP" || u.role === "OFFICE_MANAGER" || (u.role as string) === "CANVASSER");
  const projectManagers = users.filter((u) => u.role === "PROJECT_MANAGER");
  const partners = users.filter((u) => u.role === "PARTNER");

  return (
    <div className="space-y-10">

      {/* ── Team Members ── */}
      <div>
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Manage Users</h1>
            <p className="mt-1 text-sm text-gray-600">
              {teamMembers.length} team member{teamMembers.length !== 1 ? "s" : ""} ·{" "}
              {projectManagers.length} project manager{projectManagers.length !== 1 ? "s" : ""} ·{" "}
              {partners.length} partner{partners.length !== 1 ? "s" : ""}
            </p>
          </div>
          <InviteRepButton />
        </div>

        <div className="space-y-3">
          {teamMembers.map((u) => {
            const user = u as any;
            const online = isOnline(user.lastSeenAt);
            return (
              <div key={u.id} className="bg-white rounded-xl border border-gray-200 p-5">
                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${u.role === "ADMIN" ? "bg-purple-100" : "bg-blue-100"}`}>
                        <span className={`text-xs font-bold ${u.role === "ADMIN" ? "text-purple-700" : "text-blue-700"}`}>
                          {u.fullName.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                        </span>
                      </div>
                      {online && <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 border-2 border-white rounded-full" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-900">{u.fullName}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${(u.role === "ADMIN" || (u.role as string) === "OFFICE_MANAGER") ? "bg-purple-100 text-purple-800" : (u.role as string) === "CANVASSER" ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"}`}>
                          {u.role === "ADMIN" ? "Admin" : (u.role as string) === "OFFICE_MANAGER" ? "Office Manager" : (u.role as string) === "CANVASSER" ? "Canvasser" : "Sales Rep"}
                        </span>
                        {online
                          ? <span className="text-[10px] text-green-600 font-medium">Online</span>
                          : user.lastSeenAt
                            ? <span className="text-[10px] text-gray-400">Last seen {timeAgo(user.lastSeenAt)}</span>
                            : null}
                      </div>
                      <p className="text-xs text-gray-500">{u.email}</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-gray-500">{(u as any)._count?.inspections ?? 0} inspections</p>
                    <p className="text-[10px] text-gray-400">Joined {formatDate(u.createdAt)}</p>
                  </div>
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t border-gray-100">
                  {(u.role === "ADMIN" || (u.role as string) === "OFFICE_MANAGER") && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Timeclock</span>
                        <form action={async () => { "use server"; await toggleTimeclock(u.id); }}>
                          <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.timeclockEnabled ? "bg-green-500" : "bg-gray-300"}`}>
                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.timeclockEnabled ? "translate-x-4" : "translate-x-0"}`} />
                          </button>
                        </form>
                      </div>
                      <form action={async (formData: FormData) => { "use server"; const rate = parseFloat(formData.get("rate") as string); if (!isNaN(rate) && rate > 0) await setHourlyRate(u.id, rate); }} className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">$</span>
                        <input type="number" name="rate" step="0.01" min="0" defaultValue={user.hourlyRate ? Number(user.hourlyRate).toFixed(2) : ""} placeholder="0.00" className="w-16 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500" />
                        <span className="text-xs text-gray-400">/hr</span>
                        <button type="submit" className="text-[10px] text-red-600 hover:text-red-700 font-medium">Set</button>
                      </form>
                      {u.role === "ADMIN" && user.timeclockEnabled && !user.hourlyRate && (
                        <span className="text-[10px] text-gray-500">Hours tracking only — set a rate to put this admin on payroll</span>
                      )}
                    </>
                  )}
                  {(u.role as string) === "CANVASSER" && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Timeclock</span>
                        <form action={async () => { "use server"; await toggleTimeclock(u.id); }}>
                          <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.timeclockEnabled ? "bg-green-500" : "bg-gray-300"}`}>
                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.timeclockEnabled ? "translate-x-4" : "translate-x-0"}`} />
                          </button>
                        </form>
                      </div>
                      <form action={async (formData: FormData) => { "use server"; const rate = parseFloat(formData.get("rate") as string); if (!isNaN(rate) && rate > 0) await setHourlyRate(u.id, rate); }} className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">$</span>
                        <input type="number" name="rate" step="0.01" min="0" defaultValue={user.hourlyRate ? Number(user.hourlyRate).toFixed(2) : ""} placeholder="0.00" className="w-16 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500" />
                        <button type="submit" className="text-[10px] text-red-600 hover:text-red-700 font-medium">Set</button>
                      </form>
                    </>
                  )}
                  {u.role === "REP" && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Leads</span>
                        <form action={async () => { "use server"; await toggleLeadAccess(u.id); }}>
                          <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.leadAccessEnabled ? "bg-green-500" : "bg-gray-300"}`}>
                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.leadAccessEnabled ? "translate-x-4" : "translate-x-0"}`} />
                          </button>
                        </form>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Timeclock</span>
                        <form action={async () => { "use server"; await toggleTimeclock(u.id); }}>
                          <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.timeclockEnabled ? "bg-green-500" : "bg-gray-300"}`}>
                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.timeclockEnabled ? "translate-x-4" : "translate-x-0"}`} />
                          </button>
                        </form>
                      </div>
                      <form action={async (formData: FormData) => { "use server"; const rate = parseFloat(formData.get("rate") as string); if (!isNaN(rate) && rate > 0) await setHourlyRate(u.id, rate); }} className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">$</span>
                        <input type="number" name="rate" step="0.01" min="0" defaultValue={user.hourlyRate ? Number(user.hourlyRate).toFixed(2) : ""} placeholder="0.00" className="w-16 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500" />
                        <button type="submit" className="text-[10px] text-red-600 hover:text-red-700 font-medium">Set</button>
                      </form>
                      <form action={async (formData: FormData) => { "use server"; const pct = parseFloat(formData.get("commission") as string); if (!isNaN(pct) && pct >= 0 && pct <= 100) await setRepCommissionRate(u.id, pct / 100); }} className="flex items-center gap-1 mt-1">
                        <span className="text-xs text-gray-500">Commission</span>
                        <input type="number" name="commission" step="0.5" min="0" max="100" defaultValue={user.commissionRate ? (Number(user.commissionRate) * 100).toFixed(1) : ""} placeholder="0.0" className="w-14 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500" />
                        <span className="text-xs text-gray-400">%</span>
                        <button type="submit" className="text-[10px] text-red-600 hover:text-red-700 font-medium">Set</button>
                      </form>
                    </>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Daily Email</span>
                    <form action={async () => { "use server"; await toggleDailyEmail(u.id); }}>
                      <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.dailyEmailEnabled ? "bg-green-500" : "bg-gray-300"}`}>
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.dailyEmailEnabled ? "translate-x-4" : "translate-x-0"}`} />
                      </button>
                    </form>
                  </div>
                  <div className="flex-1" />
                  <form action={async () => { "use server"; await updateUserRole(u.id, u.role === "ADMIN" ? "REP" : "ADMIN"); }}>
                    <button type="submit" className="text-xs font-medium text-red-600 hover:text-red-700">
                      {u.role === "ADMIN" ? "Demote to Rep" : "Promote to Admin"}
                    </button>
                  </form>
                  <UserActionsMenu userId={u.id} userName={u.fullName} />
                  <DeleteUserButton userId={u.id} userName={u.fullName} isOfficeManager={(profile?.role as string) === "OFFICE_MANAGER"} />
                </div>
                <details className="mt-3">
                  <summary className="text-xs font-medium text-gray-600 hover:text-gray-800 cursor-pointer select-none">Edit name / email</summary>
                  <form action={async (formData: FormData) => { "use server"; await updateUserProfile(u.id, { fullName: formData.get("fullName") as string, email: formData.get("email") as string }); }} className="flex flex-wrap items-end gap-2 mt-2">
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-0.5">Full name</label>
                      <input name="fullName" defaultValue={u.fullName} required className="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-0.5">Email</label>
                      <input name="email" type="email" defaultValue={u.email} required className="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500 w-56" />
                    </div>
                    <button type="submit" className="px-3 py-1 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-700">Save</button>
                  </form>
                </details>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Project Managers ── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Project Managers</h2>
            <p className="text-sm text-gray-500">{projectManagers.length} project manager{projectManagers.length !== 1 ? "s" : ""}</p>
          </div>
        </div>

        <CreatePmForm />

        {projectManagers.length > 0 && (
          <div className="space-y-3 mt-4">
            {projectManagers.map((u) => {
              const user = u as any;
              const online = isOnline(user.lastSeenAt);
              return (
                <div key={u.id} className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-green-700 text-xs font-bold">{u.fullName.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}</span>
                        </div>
                        {online && <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 border-2 border-white rounded-full" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-gray-900">{u.fullName}</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-800">Project Manager</span>
                          {online
                            ? <span className="text-[10px] text-green-600 font-medium">Online</span>
                            : user.lastSeenAt
                              ? <span className="text-[10px] text-gray-400">Last seen {timeAgo(user.lastSeenAt)}</span>
                              : null}
                        </div>
                        <p className="text-xs text-gray-500">{u.email}</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-gray-500">{user.lastLoginAt ? `Last login ${timeAgo(user.lastLoginAt)}` : "Never logged in"}</p>
                      <p className="text-[10px] text-gray-400">Joined {formatDate(u.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t border-gray-100">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Business Card</span>
                      <form action={async () => { "use server"; const { prisma } = await import("@/lib/prisma"); await prisma.profile.update({ where: { id: u.id }, data: { hasBusinessCard: !user.hasBusinessCard } }); const { revalidatePath } = await import("next/cache"); revalidatePath("/admin/users"); }}>
                        <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.hasBusinessCard ? "bg-green-500" : "bg-gray-300"}`}>
                          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.hasBusinessCard ? "translate-x-4" : "translate-x-0"}`} />
                        </button>
                      </form>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Daily Email</span>
                      <form action={async () => { "use server"; await toggleDailyEmail(u.id); }}>
                        <button type="submit" className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${user.dailyEmailEnabled ? "bg-green-500" : "bg-gray-300"}`}>
                          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${user.dailyEmailEnabled ? "translate-x-4" : "translate-x-0"}`} />
                        </button>
                      </form>
                    </div>
                    <div className="flex-1" />
                    <form action={async () => { "use server"; await updateUserRole(u.id, "REP"); }}>
                      <button type="submit" className="text-xs font-medium text-gray-500 hover:text-gray-700">Demote to Rep</button>
                    </form>
                    <DeleteUserButton userId={u.id} userName={u.fullName} />
                  </div>
                  <details className="mt-3">
                    <summary className="text-xs font-medium text-gray-600 hover:text-gray-800 cursor-pointer select-none">Edit name / email</summary>
                    <form action={async (formData: FormData) => { "use server"; await updateUserProfile(u.id, { fullName: formData.get("fullName") as string, email: formData.get("email") as string }); }} className="flex flex-wrap items-end gap-2 mt-2">
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-0.5">Full name</label>
                        <input name="fullName" defaultValue={u.fullName} required className="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500" />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-0.5">Email</label>
                        <input name="email" type="email" defaultValue={u.email} required className="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-red-500 focus:border-red-500 w-56" />
                      </div>
                      <button type="submit" className="px-3 py-1 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-700">Save</button>
                    </form>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Partners ── */}
      {partners.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-gray-900 mb-1">Partners</h2>
          <p className="text-sm text-gray-500 mb-4">{partners.length} partner account{partners.length !== 1 ? "s" : ""}</p>

          <div className="space-y-3">
            {partners.map((u) => {
              const user = u as any;
              const online = isOnline(user.lastSeenAt);
              return (
                <div key={u.id} className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-red-700 text-xs font-bold">{u.fullName.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}</span>
                        </div>
                        {online && <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 border-2 border-white rounded-full" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-gray-900">{u.fullName}</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-800">Partner</span>
                          {online
                            ? <span className="text-[10px] text-green-600 font-medium">Online</span>
                            : user.lastSeenAt
                              ? <span className="text-[10px] text-gray-400">Last seen {timeAgo(user.lastSeenAt)}</span>
                              : null}
                        </div>
                        <p className="text-xs text-gray-500">{u.email}</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-gray-500">{user.lastLoginAt ? `Last login ${timeAgo(user.lastLoginAt)}` : "Never logged in"}</p>
                      <p className="text-[10px] text-gray-400">Joined {formatDate(u.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t border-gray-100">
                    <div className="flex-1" />
                    <DeleteUserButton userId={u.id} userName={u.fullName} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
