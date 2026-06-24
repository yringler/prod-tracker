import { CUSTOM_ELEMENTS_SCHEMA, Component } from "@angular/core";
import { RouterLink } from "@angular/router";

// Public privacy policy. Reachable without auth so Atlassian's OAuth review
// (and end users) can read it before connecting Jira. Keep the data practices
// here in sync with what the app actually stores/derives.
@Component({
    selector: "sp-privacy",
    standalone: true,
    imports: [RouterLink],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
    template: `
        <div class="panel wa-prose" style="margin-top:24px">
            <h1>Privacy Policy</h1>
            <p class="muted">Last updated: 23 June 2026</p>

            <p>
                Story-Point Effort Tracker (the &ldquo;Service&rdquo;) helps
                teams compare the effort people put into work against the story
                points recorded in Jira. This policy explains what we collect,
                why, and how we handle it. The Service is operated by Yehuda
                Ringler. Contact:
                <a href="mailto:yrappdev@gmail.com">yrappdev@gmail.com</a>.
            </p>

            <h2>Information we collect</h2>
            <ul>
                <li>
                    <strong>Atlassian account information.</strong> When you
                    connect Jira via Atlassian OAuth 2.0, we receive your
                    Atlassian account ID, display name, and the list of Jira
                    sites you authorize. We use this to identify you and to know
                    which site's data to read.
                </li>
                <li>
                    <strong>Jira issue data.</strong> With your consent we read
                    issues, sprints, story points, and issue change history
                    (status transitions) for the authorized site. We store
                    snapshots of this data so we can show you tickets to rate
                    and compute team aggregates.
                </li>
                <li>
                    <strong>Your effort ratings.</strong> The effort percentages
                    you submit for each ticket are stored against your account.
                    With each rating we also store a snapshot of the issue's key
                    and title so we can show you your own history.
                </li>
                <li>
                    <strong>Your notes.</strong> When you rate a ticket you may
                    optionally add a free-text note (a short diary of what you
                    did). Notes are stored against your account and are shown only
                    to you, never to other users or admins.
                </li>
                <li>
                    <strong>Push notification subscriptions.</strong> If you
                    enable browser notifications, we store the subscription
                    endpoint your browser provides so we can prompt you to rate
                    tickets as they change status.
                </li>
            </ul>

            <h2>How we use your information</h2>
            <ul>
                <li>To show you the tickets that need an effort rating.</li>
                <li>
                    To compute and display <em>team-level</em> aggregates
                    (claimed effort vs. completed Jira points).
                </li>
                <li>To send you notifications you have opted into.</li>
            </ul>

            <h2>Your ratings stay private</h2>
            <p>
                Individual effort ratings are never shown to other users,
                including team admins. Only anonymized, team-level aggregates
                are shared. We do not write any data back to Jira.
            </p>

            <h2>How we share information</h2>
            <p>
                We do not sell your data and we do not share it with third
                parties for advertising. Data is processed only by the
                infrastructure providers needed to run the Service:
            </p>
            <ul>
                <li>
                    <strong>Atlassian</strong> — the source of Jira data you
                    authorize us to read.
                </li>
                <li>
                    <strong>Cloudflare</strong> — hosting, compute, and storage
                    for the Service.
                </li>
            </ul>

            <h2>Data retention and deletion</h2>
            <p>
                We retain your data for as long as your account is connected.
                You can revoke the Service's access at any time from your
                Atlassian account settings. To request deletion of the data we
                hold about you, email
                <a href="mailto:yrappdev@gmail.com">yrappdev@gmail.com</a> and
                we will remove it.
            </p>

            <h2>Changes to this policy</h2>
            <p>
                We may update this policy from time to time. Material changes
                will be reflected by the &ldquo;Last updated&rdquo; date above.
            </p>

            <h2>Contact</h2>
            <p>
                Questions about this policy? Email
                <a href="mailto:yrappdev@gmail.com">yrappdev@gmail.com</a>.
            </p>

            <p style="margin-top:24px">
                <a routerLink="/"><wa-icon name="arrow-left"></wa-icon> Back to the app</a>
            </p>
        </div>
    `,
})
export class PrivacyComponent {}
