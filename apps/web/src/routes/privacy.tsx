import { Link, createFileRoute } from '@tanstack/react-router'
import { LegalPage, LegalSection } from '~/components/forge/legal'

export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [{ title: 'Privacy policy · cobalt' }],
  }),
  component: Privacy,
})

const sections: Array<[string, string]> = [
  ['who', 'Who we are'],
  ['collect', 'What we collect'],
  ['use', 'What we do with it'],
  ['where', 'Where it lives and who handles it'],
  ['see', 'Who can see it'],
  ['control', 'Your choices and your data'],
  ['changes', 'Changes to this policy'],
  ['open', 'Still to be decided'],
]

function Privacy() {
  return (
    <LegalPage
      title="Privacy policy"
      updated="Draft of November 21, 2026"
      intro="What cobalt collects, why, who can see it, and how to take it with you. It is written in plain words on purpose."
      sections={sections}
    >
      <LegalSection id="who" title="Who we are">
        <p>
          cobalt is operated by Marco Procopio. It hosts git repositories,
          reviews changes and lands them under policies you set. There is no
          contact address for privacy questions yet; choosing one is the first
          item under &ldquo;Still to be decided&rdquo;.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="What we collect">
        <ul>
          <li>
            <b>Your account.</b> Your full name, your email address and a
            password, which is never kept in a readable form. Your page has an
            address, generated when you sign up, that you can change. An
            organization has a name, a description, an address and a list of its
            members and their roles.
          </li>
          <li>
            <b>Your work.</b> The repositories, commits, issues, reviews and
            releases you push or import. A repository is public or private;
            anyone can see a public one.
          </li>
          <li>
            <b>History you import.</b> When you link GitHub, GitLab, Codeberg or
            Gitea, we read what the permissions you grant allow: your profile,
            repository details, issues, review threads, releases and
            contribution history. The connect screen lists them before you
            agree. Linking never lets anyone sign in with that account.
          </li>
          <li>
            <b>Secrets.</b> Environment values are designed to be encrypted on
            your machine before they reach us, so we hold ciphertext and not the
            values. A diff shows which key changed and nothing about what it
            changed to.
          </li>
          <li>
            <b>Use of the service.</b> How much storage and transfer your
            account uses, which plans and limits depend on, and an audit trail
            of sensitive actions, such as an agent being given access to
            secrets.
          </li>
          <li>
            <b>Payment.</b> The Free plan needs no card. A card is needed only
            to pay for a plan. Card details are handled by a payment provider
            and we do not keep full card numbers.
          </li>
          <li>
            <b>Basics of every visit.</b> A cookie that keeps you signed in,
            your theme choice stored in your browser, and the ordinary records
            any server keeps of a request. Both are strictly needed to run the
            site, so there is no cookie banner: nothing else is stored in your
            browser.
          </li>
          <li>
            <b>Product analytics.</b> Our servers record which features are
            used, such as an account being created, and send those events to our
            analytics provider. An event carries your address on the site (your
            handle), not your email, and it is sent from our servers, so there
            are no analytics cookies or scripts in your browser. The provider
            builds no profile of you.
          </li>
        </ul>
        <p>The app does not use advertising or cross-site tracking.</p>
      </LegalSection>

      <LegalSection id="use" title="What we do with it">
        <ul>
          <li>Store your repositories and serve them as you configure them.</li>
          <li>
            Sync with other hosts when you set up a mirror, in the direction you
            chose.
          </li>
          <li>Run plans, limits and billing, and keep the service secure.</li>
          <li>
            Email you about signing in, security, invitations and your plan.
          </li>
        </ul>
        <p>
          We do not sell your personal data. We do not resell compute or tokens
          either: the runner, model and agent you use are between you and the
          provider you chose.
        </p>
      </LegalSection>

      <LegalSection id="where" title="Where it lives and who handles it">
        <p>
          cobalt is hosted in the United States. These companies process data
          for us, only to run the service:
        </p>
        <ul>
          <li>
            <b>Convex</b>: the database and backend (United States).
          </li>
          <li>
            <b>Railway</b>: the web servers (United States).
          </li>
          <li>
            <b>Pierre, code.storage</b>: git storage (United States).
          </li>
          <li>
            <b>PostHog</b>: product analytics (European Union).
          </li>
          <li>
            <b>Axiom</b>: logs and traces of how the service performs (European
            Union).
          </li>
        </ul>
        <p>
          If you are in the European Economic Area, the United Kingdom or
          Switzerland, your data is transferred to the United States. We rely on
          the EU&ndash;US Data Privacy Framework where a processor is certified,
          and on standard contractual clauses where the processor&rsquo;s
          agreement includes them. We have a data processing agreement with each
          processor. Companies that need their data kept in a given region can
          ask about it for the Enterprise plan, where it would run as a separate
          deployment.
        </p>
      </LegalSection>

      <LegalSection id="see" title="Who can see it">
        <ul>
          <li>
            <b>Everyone</b> sees your public repositories and your public
            profile. An organization&rsquo;s page shows its members and which of
            them are owners or admins.
          </li>
          <li>
            <b>You decide what your profile shows</b> in{' '}
            <Link
              to="/settings/$section"
              params={{ section: 'privacy' }}
              className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
            >
              Settings, Privacy
            </Link>
            : a combined contribution total, private contributions as counts
            only (titles and repositories are never shown), recent activity, how
            you work with agents, and whether people can find you by name.
          </li>
          <li>
            <b>Where a project came from</b> is shown only to you, in your
            settings, and in the settings of the repository, which only the
            people who manage it can open. Visitors never see which host a
            project was imported from.
          </li>
          <li>
            <b>Agents and tools you connect</b> act with scoped tokens and get
            only what you grant. An agent never receives a secret value. It
            receives the ability to run a command that has them, and what the
            command prints is scrubbed.
          </li>
          <li>
            <b>Services you link</b>, such as reviewers, runners and agent
            environments, receive what they need to do their job. You choose
            them and can remove them.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="control" title="Your choices and your data">
        <ul>
          <li>
            Change your name, email and address in settings. If you change your
            address, the old one keeps redirecting and nobody else can take it.
          </li>
          <li>
            <b>Take your work with you.</b> Your repositories are plain git, so
            you can clone them any time, and mirrors keep copies on other hosts.
            Removing a mirror never deletes anything here.
          </li>
          <li>
            If you stop paying, your account moves to the Free plan and your
            history stays readable, cloneable and downloadable for 90 days. We
            tell you before anything is deleted. Going over your limits pauses
            new pushes and never deletes anything by itself.
          </li>
          <li>
            <b>Download your data.</b> In Settings, Plan and data, one click
            gives you a file with your profile, preferences, organizations,
            follows and the list of your repositories.
          </li>
          <li>
            <b>Delete your account.</b> From the same page, by typing your
            address. Your account and your repositories then only read for 30
            days, in which you can clone everything, download your data and
            change your mind with one click. After the 30 days your account, the
            repositories it owns, your preferences, tokens, sealed secrets and
            linked accounts are erased and cannot be brought back. What you
            wrote in other people&rsquo;s repositories, such as issues, comments
            and changes, stays under the name &ldquo;ghost&rdquo;, and git
            commits keep the author line they were made with, as git requires.
            The public activity feed keeps a count, not your name. An
            organization you are the only owner of must be handed over or
            deleted first. Your address stays reserved so nobody else can pose
            as you. Invoices are kept by our payment provider for as long as tax
            law requires, usually ten years.
          </li>
          <li>
            You can leave an organization at any time. What it owns stays with
            it.
          </li>
          <li>
            Disconnecting a linked account stops syncing with it. History
            already imported stays here.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this policy">
        <p>
          When this policy changes in a way that matters, we will tell you by
          email and in the app before it applies, and the date at the top will
          change.
        </p>
      </LegalSection>

      <LegalSection id="open" title="Still to be decided">
        <p>
          These need an answer, and a lawyer&rsquo;s review, before the service
          takes real accounts:
        </p>
        <ul>
          <li>The contact address for privacy questions and requests.</li>
          <li>How long backups and server logs are kept.</li>
          <li>
            The payment provider and the email provider, which are not chosen
            yet and will be added to the list above.
          </li>
          <li>The country whose law applies.</li>
          <li>The minimum age to use the service.</li>
        </ul>
      </LegalSection>
    </LegalPage>
  )
}
