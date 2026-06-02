import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import {
  Book,
  MessageCircle,
  Zap,
  FileQuestion,
  Search,
  ChevronDown,
  Captions,
  CalendarDays,
  Clock,
  Link2,
  Activity,
} from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/help")({
  head: () => ({ meta: [{ title: "Help — Alyson HR" }] }),
  component: HelpPage,
});

const SUPPORT_EMAIL = "thirumalai@cintara.ai";

const TOPICS = [
  {
    icon: Book,
    title: "Getting started",
    desc: "Onboard to Alyson: workspace basics, people data, and where to find deeper guides below.",
    faq: [
      {
        q: "What should I do first?",
        a: "Confirm your role in the app shell, explore Team and core HR areas you use day to day, then read the sections for Alyson Notetaker, Meeting calendar, and Time dashboard if your org uses them. Super admins unlock additional tools from the shell.",
      },
      {
        q: "How do I import existing employees?",
        a: "Use the CSV importer in Admin → Data sources, or paste from your old HRIS. We'll match levels and departments automatically.",
      },
      {
        q: "What if I don't have all comp data?",
        a: "Start with name, email, role, department. You can backfill base salary and bonus % later — every other metric will update automatically.",
      },
      {
        q: "Can I trial without committing?",
        a: "Yes — create a sandbox workspace from the role switcher. Nothing in sandbox is published.",
      },
    ],
  },
  {
    icon: Captions,
    title: "Alyson Notetaker",
    desc: "Meeting bot: join link, live transcripts, AI notes, and persist to secure storage.",
    faq: [
      {
        q: "How do I set up a meeting for the bot?",
        a: "Give the meeting a clear name so it is easy to find later. Paste the full meeting link (Zoom, Google Meet, Microsoft Teams, or other supported provider) into the link field on the Notetaker screen before the call starts.",
      },
      {
        q: "When does the bot join?",
        a: "After you submit the meeting details, the bot typically joins within about 10 seconds. Once connected, it listens to the call and produces real-time transcripts you can follow as the conversation happens.",
      },
      {
        q: "How do I generate meeting notes?",
        a: "Open the Notes area for that session. When you are ready, use the control to generate meeting notes from the transcript. Review the output, then edit if needed before saving.",
      },
      {
        q: "What does Persist do?",
        a: "Persist writes the current notes (and related session data) to cloud storage (S3) so they are retained for your workspace. Use it when you want the official copy saved and available for later review or compliance.",
      },
      {
        q: "Who can use Notetaker?",
        a: "Notetaker is intended for super-admin workflows. If you do not see it in the navigation, ask your workspace super admin to confirm your access.",
      },
    ],
  },
  {
    icon: CalendarDays,
    title: "Meeting calendar",
    desc: "See every meeting your Alyson bot was invited to, in one place.",
    faq: [
      {
        q: "What is the Meeting calendar for?",
        a: "It lists meetings where the Notetaker bot was added or invited. Use it to scan upcoming and past sessions, open a meeting for details, and cross-check that the bot is on the right calls.",
      },
      {
        q: "How do I find a specific meeting?",
        a: "Use the calendar layout and meeting titles. Match the name you used when creating the session in Notetaker, or look by date and time.",
      },
    ],
  },
  {
    icon: Link2,
    title: "Handover documentation",
    desc: "Simple employee-to-document link registry for handovers, stored in S3.",
    faq: [
      {
        q: "What is Handover Documentation used for?",
        a: "It is a lightweight table for operational handovers: one employee name and one documentation link per row. Use it for runbooks, ownership docs, KT notes, and transition links.",
      },
      {
        q: "Where is the data stored?",
        a: "Entries are stored in S3 under the org chart bucket (`alyson-hr-orgchart`) at `alyson-hr-handoverdocumetnation/index.json`.",
      },
      {
        q: "Can I export the handover list?",
        a: "Yes. Use Export CSV on the Handover Documentation page to download the current list for sharing or offline review.",
      },
      {
        q: "Is delete protected?",
        a: "Yes. Deleting a row requires confirmation by typing `DELETE` in the confirmation dialog.",
      },
    ],
  },
  {
    icon: Activity,
    title: "Workspace activity",
    desc: "Google Workspace activity metrics per user (emails, meetings, docs, chat) with custom time windows.",
    faq: [
      {
        q: "What does Workspace Activity measure?",
        a: "Per user it shows outbound emails sent, meetings in selected window, Google Docs created, and Chat messages sent.",
      },
      {
        q: "How do I use custom date/time filters?",
        a: "Set Start and End datetime, then click Apply window. The table and charts refresh for that exact window.",
      },
      {
        q: "Can I search a specific user quickly?",
        a: "Yes. Use the search box on the module page to filter by user email and focus on one person’s metrics instantly.",
      },
      {
        q: "Can I export reports?",
        a: "Yes. Export CSV for raw data and Export PDF for KPI summary, charts, and full table.",
      },
      {
        q: "Why can newly created docs/events take time to appear?",
        a: "Google Admin audit feeds are near-real-time but not always immediate. Short ingestion delay is normal; refresh after a few minutes if needed.",
      },
    ],
  },
  {
    icon: Clock,
    title: "Time dashboard",
    desc: "Super-admin view of employee working time, app and site usage, and range-based summaries.",
    faq: [
      {
        q: "What can I see on the Time dashboard?",
        a: "You get a list of employees with their working hours. Select someone to open a detail view with a deeper breakdown, including where the most time was spent across apps and websites (when that data is available from your integration).",
      },
      {
        q: "How do date and time ranges work?",
        a: "Set a start and end for the period you care about. All working-hour metrics and summaries on the page respect that range so you are not mixing unrelated weeks or months.",
      },
      {
        q: "What summaries are available?",
        a: "You can interpret daily, weekly, and monthly working hours from the same underlying data by adjusting the range: pick a single day for daily-style review, a week for weekly patterns, or a full month for monthly rollups.",
      },
      {
        q: "Who can access the Time dashboard?",
        a: "It is restricted to super admins. If you need access for compliance or IT, ask a super admin in your organization.",
      },
    ],
  },
  {
    icon: Zap,
    title: "Run your first payroll",
    desc: "From draft to Wise export in under 10 minutes.",
    faq: [
      { q: "How are payroll items generated?", a: "Each run pulls base salary from compensation, overlays approved bonuses, and applies any approved adjustments. You can override any line." },
      { q: "What format does Wise need?", a: "We export their standard CSV: recipient, currency, amount, reference. Click Wise CSV on any approved run." },
      { q: "Can I roll back a paid run?", a: "Paid runs are immutable. Issue an adjustment in the next run instead." },
    ],
  },
  {
    icon: FileQuestion,
    title: "Equity & vesting",
    desc: "How to model grants, cliff periods, and acceleration clauses.",
    faq: [
      { q: "What's the cliff vs vesting period?", a: "The cliff is when the first chunk vests (typically 12 months). After that, shares vest monthly across the remaining years." },
      { q: "Can I add acceleration?", a: "Yes — open any grant and toggle 'Single-trigger' or 'Double-trigger' acceleration. Affects forecast immediately." },
      { q: "How is equity expense projected?", a: "We amortize the next 6 months of vesting events and apply the active scenario factor." },
    ],
  },
  {
    icon: MessageCircle,
    title: "Contact support",
    desc: `Email ${SUPPORT_EMAIL} for product questions, access issues, or onboarding help.`,
    faq: [
      {
        q: "How do I reach support?",
        a: `Write to ${SUPPORT_EMAIL}. Include your workspace name, role, and a short description of what you were trying to do (with screenshots if helpful).`,
      },
      {
        q: "Can I still use Ask Alyson in the app?",
        a: "Yes — use Ask Alyson in the top bar for quick how-tos inside the product. For account access, billing, or anything that needs a human, email the address above.",
      },
      {
        q: "What response time can I expect?",
        a: "We aim to reply on UK business days as soon as practical. For urgent production issues, mark the subject line URGENT and include the time zone you are in.",
      },
    ],
  },
];

function HelpPage() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const filtered = TOPICS.map((t) => ({
    ...t,
    faq: t.faq.filter((f) => !q || f.q.toLowerCase().includes(q.toLowerCase()) || f.a.toLowerCase().includes(q.toLowerCase())),
  })).filter((t) => !q || t.faq.length || t.title.toLowerCase().includes(q.toLowerCase()) || t.desc.toLowerCase().includes(q.toLowerCase()));

  const activeTopic = filtered.find((t) => t.title === open) ?? null;

  return (
    <div>
      <PageHeader
        eyebrow="Resources"
        title="Help & docs"
        description="Everything you need to operate confidently — onboarding, Notetaker, calendar, handover docs, workspace activity, time tracking, payroll, equity, and support."
      />
      <div className="px-5 md:px-8 py-4 md:py-5 space-y-4 max-w-5xl mx-auto">
        <div className="relative max-w-xl">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search help topics and FAQs…"
            className="w-full h-9 pl-8 pr-2.5 rounded-md border border-border bg-background text-[12px]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-stretch">
          {filtered.map((t) => {
            const isOpen = open === t.title;
            return (
              <div key={t.title} className="surface-card overflow-hidden flex flex-col min-w-0 rounded-lg h-full">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : t.title)}
                  className="w-full p-3.5 flex items-start gap-2.5 text-left hover:bg-muted/30 shrink-0 min-h-[108px]"
                >
                  <div className="h-8 w-8 rounded-md bg-accent text-accent-foreground grid place-items-center shrink-0">
                    <t.icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[13px] leading-tight">{t.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-1 leading-snug line-clamp-3">{t.desc}</div>
                  </div>
                  <ChevronDown className={"h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0 mt-0.5 " + (isOpen ? "rotate-180" : "")} />
                </button>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="surface-card p-6 text-center sm:col-span-2 lg:col-span-3 rounded-lg">
              <div className="text-[14px] font-medium">No matches</div>
              <div className="text-[12px] text-muted-foreground mt-1">Try a different search term, or <button onClick={() => { /* opens AI from app shell */ }} className="text-primary hover:underline">ask Alyson</button>.</div>
            </div>
          )}
        </div>

        {activeTopic && (
          <div className="surface-card overflow-hidden rounded-lg">
            <div className="p-3.5 border-b border-border bg-muted/20">
              <div className="font-medium text-[13px]">{activeTopic.title}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{activeTopic.desc}</div>
            </div>
            <div className="divide-y divide-border">
              {activeTopic.faq.map((f, i) => (
                <div key={i} className="px-3 py-2.5">
                  <div className="font-medium text-[12px] leading-snug">{f.q}</div>
                  <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{f.a}</div>
                </div>
              ))}
              {activeTopic.faq.length === 0 && (
                <div className="px-3 py-2.5 text-[11px] text-muted-foreground italic">No FAQs match your search.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
