import {
  LEGAL_EFFECTIVE_DATE,
  LEGAL_OPERATOR,
  PRIVACY_EMAIL,
  PUBLIC_ORIGIN,
  SUPPORT_EMAIL,
} from '../legal.ts';
import type { LegalRoute } from '../components/LegalFooter.tsx';

type LegalPageKind = 'legal' | 'privacy' | 'terms' | 'refunds';

interface LegalPageProps {
  kind: LegalPageKind;
  backLabel?: string;
  onBack: () => void;
  onNavigate: (route: LegalRoute) => void;
}

const providerLinks = [
  ['Cloudflare', 'https://www.cloudflare.com/privacypolicy/'],
  ['Clerk', 'https://clerk.com/legal/privacy'],
  ['Stripe', 'https://stripe.com/privacy'],
  ['Google Gemini API', 'https://ai.google.dev/gemini-api/terms'],
  ['fal', 'https://fal.ai/legal/privacy-policy'],
  ['Runway', 'https://runway.com/privacy-policy'],
  ['Freepik', 'https://www.freepik.com/legal/privacy'],
] as const;

function OperatorDetails() {
  return (
    <address className="legal-page__address">
      <strong>{LEGAL_OPERATOR.name}</strong>
      <span>NIF {LEGAL_OPERATOR.taxId}</span>
      <span>{LEGAL_OPERATOR.registry}</span>
      <span>{LEGAL_OPERATOR.address}</span>
      <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>
    </address>
  );
}

function LegalNotice() {
  return (
    <>
      <header className="legal-page__intro">
        <p className="gallery-eyebrow">Operator Information</p>
        <h1>Legal Notice</h1>
        <p>This notice identifies the company responsible for Insert Player and the commercial service available at insertplayer.ai.</p>
      </header>

      <section>
        <h2>1. Service operator</h2>
        <OperatorDetails />
        <p>Insert Player is an online service for creating, storing, playing, and sharing AI-generated video game fighters and for purchasing digital generation credits.</p>
      </section>

      <section>
        <h2>2. Contact</h2>
        <p>For service, billing, or legal questions, email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. For privacy and data-protection requests, email <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.</p>
      </section>

      <section>
        <h2>3. Prices and taxes</h2>
        <p>Credit-pack and generation prices are shown before purchase or use. Consumer prices include applicable taxes when stated at Checkout. There are no shipping costs because the service supplies digital content only. The Terms of Service and Cancellations &amp; Remedies Policy explain credit use, immediate digital performance, service failures, and mandatory remedies.</p>
      </section>

      <section>
        <h2>4. Intellectual property</h2>
        <p>The Insert Player name, interface, software, and original game assets are protected by applicable intellectual-property laws. User inputs and generated fighter assets are governed by the Terms of Service. Third-party names, marks, services, and game references belong to their respective owners; their mention does not imply sponsorship or endorsement.</p>
      </section>

      <section>
        <h2>5. Acceptable access</h2>
        <p>You may use this site only in accordance with applicable law and the Terms of Service. You may not interfere with the service, bypass access or payment controls, extract private assets, or use Insert Player to violate another person's rights.</p>
      </section>

      <section>
        <h2>6. Applicable law</h2>
        <p>Spanish law applies, without limiting mandatory consumer protections or court options available in your country of residence. Contact us first so we can try to resolve a complaint directly.</p>
      </section>
    </>
  );
}

function PrivacyPolicy() {
  return (
    <>
      <header className="legal-page__intro">
        <p className="gallery-eyebrow">Player Data</p>
        <h1>Privacy Policy</h1>
        <p>This policy explains what happens to your account, photos, generated fighters, payments, and public shares when you use Insert Player.</p>
      </header>

      <section>
        <h2>1. Who controls your data</h2>
        <p>{LEGAL_OPERATOR.name} is the data controller for Insert Player.</p>
        <OperatorDetails />
      </section>

      <section>
        <h2>2. Data we process</h2>
        <ul>
          <li>Account data from Clerk, including your user ID, email, display name, and profile image.</li>
          <li>Photos you upload, generated source views, sprite sheets, fighter names, quality tier, and version history.</li>
          <li>Match records, public fighter choices, clone activity, credit balance, and generation charge history.</li>
          <li>Checkout references and payment status from Stripe. Insert Player does not receive or store your full card number.</li>
          <li>Community reports, bounded report details, report counts, moderation decisions, and moderator notes.</li>
          <li>Security and diagnostic data, including pseudonymized network identifiers, request timing, errors, and abuse counters.</li>
        </ul>
        <p>Insert Player does not use your photo to verify your identity, identify you in other images, or create a biometric identity database.</p>
      </section>

      <section>
        <h2>3. Why we process it</h2>
        <ul>
          <li>To create, privately store, sync, upgrade, and play the fighter you request, and to publish its generated assets only when you choose.</li>
          <li>To authenticate your account, fulfil purchases, settle generation credits, investigate failures, and provide support or mandatory remedies.</li>
          <li>To prevent fraud, enforce rate limits, secure private assets, and investigate service failures.</li>
          <li>To investigate community safety reports and remove content that breaches these terms or applicable law.</li>
          <li>To meet tax, accounting, consumer-protection, and other legal duties.</li>
        </ul>
        <p>Our legal bases are performance of our contract with you, your consent where we ask for it, our legitimate interests in operating and securing the service, and compliance with legal obligations.</p>
      </section>

      <section>
        <h2>4. Photos and AI providers</h2>
        <p>Your original photo is sent through Insert Player's Cloudflare backend only to Google Gemini to create the fighter you requested. Clerk and Stripe do not receive that uploaded photo. Refined tiers may send generated frames, but not the original upload, to fal or Freepik for background removal. Runway or Freepik receives generated fighter assets only if you separately request an optional video workflow.</p>
        <p>Insert Player uses the paid Gemini API. Under Google's terms current on this policy date, Google does not use paid-service prompts, uploaded files, or responses to improve its products, although it may retain limited logs for abuse prevention and legal compliance. The providers may process data outside the European Economic Area under their data-processing terms and transfer safeguards.</p>
        <p>Your generation permission is limited to creating and privately storing the fighter you request. It is not a licence for Insert Player to publish or reuse your photo or private fighter for another purpose. Insert Player does not sell your photo or private fighter assets, use either in advertising or promotion, or use either to train its own models. Your original photo remains private and is never published, including when you choose to publish the generated fighter.</p>
        <div className="legal-page__link-list">
          {providerLinks.map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">{label}</a>
          ))}
        </div>
        <p>Do not upload a photo of another person unless they have clearly agreed to this processing. Do not upload photos of anyone under 18.</p>
      </section>

      <section>
        <h2>5. Storage and retention</h2>
        <ul>
          <li>Anonymous provider inputs stored by Insert Player expire from temporary Cloudflare storage after one day.</li>
          <li>Signed-in source photos, generated views, and every generated version remain in your roster until you delete the fighter or account.</li>
          <li>Expired provider sessions are removed after seven days. Stripe and Clerk webhook audit markers are removed after 180 days.</li>
          <li>Minimal records proving generation and checkout consent are retained for up to six years, then deleted.</li>
          <li>Open community reports remain while review is needed. Dismissed and actioned reports are deleted after one year.</li>
          <li>Payment and tax records may remain with Stripe or in legally required accounting records for the applicable statutory period.</li>
        </ul>
      </section>

      <section>
        <h2>6. Community sharing</h2>
        <p>Fighters are private to their Insert Player account unless the owner separately confirms Publish. Public pages expose the fighter name, clean generated source views and playable assets, quality tier, and the neutral author label Player. Account names, emails, Clerk profile photos, original uploads, raw intermediates, private photo hashes, account IDs, and archived private versions are never published. A future public handle will require a separate opt-in.</p>
        <p>Signed-in players can report a public fighter for review. Reports do not trigger automatic removal based on volume; an authorised moderator records a decision and may unpublish content after review.</p>
        <p>You can unpublish a fighter at any time. Short-lived network caches may take a brief period to expire.</p>
      </section>

      <section>
        <h2>7. Cookies and local storage</h2>
        <p>At launch, Insert Player uses only storage needed for authentication, security, checkout return state, local roster data, and gameplay. We do not run advertising trackers or optional analytics. Cloudflare Turnstile may use necessary security storage to distinguish people from automated abuse.</p>
      </section>

      <section>
        <h2>8. Your choices and rights</h2>
        <p>You may ask to access, correct, export, restrict, object to, or erase personal data, and may withdraw consent where consent is the legal basis. Signed-in players can delete individual fighters from the roster and delete their account through the Clerk player profile. Account deletion triggers deletion of the account's Insert Player database rows and R2 assets, and deletes the reusable Stripe Customer profile and payment methods while Stripe retains legally required transaction history. A moderation record may remain for its stated retention period with deleted user references removed.</p>
        <p>Email <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a> for a data request. You may also complain to the Spanish Data Protection Agency or your local supervisory authority.</p>
      </section>

      <section>
        <h2>9. Age limit</h2>
        <p>Insert Player is intended only for people aged 18 or older. If you believe a minor's photo or account data has been submitted, contact us so we can remove it.</p>
      </section>

      <section>
        <h2>10. Security and changes</h2>
        <p>We use encrypted transport, server-side provider credentials, account-scoped storage, private object access, rate limits, and deletion workflows. No online service can guarantee absolute security. Material policy changes will be dated here and communicated when legally required.</p>
      </section>
    </>
  );
}

function TermsOfService() {
  return (
    <>
      <header className="legal-page__intro">
        <p className="gallery-eyebrow">Cabinet Rules</p>
        <h1>Terms of Service</h1>
        <p>These terms govern Insert Player, including fighter generation, cloud sync, community sharing, gameplay, and credit purchases.</p>
      </header>

      <section>
        <h2>1. Operator and agreement</h2>
        <p>Insert Player is operated by {LEGAL_OPERATOR.name}. By creating an account, buying credits, or starting generation, you agree to these terms and the Privacy Policy.</p>
        <OperatorDetails />
      </section>

      <section>
        <h2>2. Eligibility</h2>
        <p>You must be at least 18 and legally able to enter a contract. You are responsible for your account and for activity performed through it.</p>
      </section>

      <section>
        <h2>3. Your photos and instructions</h2>
        <ul>
          <li>You must own or have clear permission to use every photo and other input you submit.</li>
          <li>You may not submit a minor's photo or create a fighter of a non-consenting person.</li>
          <li>You may not use the service for impersonation, deception, harassment, sexual content, hate, unlawful violence, or infringement of privacy or intellectual-property rights.</li>
          <li>You remain responsible for the inputs you submit and how you use or publish the output.</li>
        </ul>
      </section>

      <section>
        <h2>4. Generated content</h2>
        <p>You retain the rights you hold in your inputs. As between you and Insert Player, we do not claim ownership of the generated fighter assets delivered to your roster. We grant you a non-exclusive licence to use those assets for lawful personal or commercial purposes, subject to applicable law, third-party rights, and any provider terms that apply.</p>
        <p>Any permission needed to process and host your inputs is limited to operating the private service you request. It is not a licence to publish or reuse your photo or private fighter for another purpose, and it does not permit us to use either in advertising or promotion or to train an Insert Player model with either.</p>
        <p>AI output can be inaccurate, unexpected, or similar to other output and may not qualify for copyright protection. We do not guarantee exclusivity, likeness accuracy, or freedom from third-party claims.</p>
      </section>

      <section>
        <h2>5. Credits, generations, and taxes</h2>
        <ul>
          <li>Credit packs are one-time purchases. Credits have no cash value, are not transferable, and do not expire while your account remains active.</li>
          <li>The selected tier shows its credit cost before generation begins. Prices shown to consumers include applicable tax where the checkout says so.</li>
          <li>Credits are reserved when a generation is accepted. If Insert Player cannot start external AI processing, the unused reservation is released. Once the first external AI request begins, the displayed credits are consumed and are not automatically restored because a provider fails, the job is delayed, or the result needs remediation.</li>
          <li>An approved payment refund or payment dispute reverses the corresponding pack credits. If those credits were already spent, your wallet may become negative and further paid generation remains unavailable until the balance is restored.</li>
          <li>When you start a paid generation, you request immediate performance and acknowledge that consumed credits are not voluntarily refundable after external AI processing begins. This does not limit mandatory remedies for non-delivery, material lack of conformity, duplicate billing, or an incorrect charge.</li>
        </ul>
      </section>

      <section>
        <h2>6. Public fighters</h2>
        <p>Publishing is optional and requires a separate confirmation. For the fighter you choose to publish, you grant us a worldwide, non-exclusive, revocable licence to host, display, copy, and deliver its clean generated source views and playable assets so other players can view, play, share, and clone that fighter inside Insert Player. We show the neutral author label Player. This never includes your account name, email, Clerk profile photo, original photo, raw intermediates, private hashes, or archived generation history. A future public handle will require a separate opt-in. Unpublishing ends new public distribution, subject to short cache expiry and copies another player already cloned into their own roster.</p>
        <p>Signed-in players may report public content. We review reports manually and may unpublish content, restrict community access, suspend accounts, preserve necessary evidence, or take no action. Report volume alone does not decide the outcome. Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if you believe a moderation decision is mistaken.</p>
      </section>

      <section>
        <h2>7. Service changes and availability</h2>
        <p>Generation depends on external AI providers and may be delayed or unavailable. We may change providers, balance gameplay, add or remove features, or suspend abusive accounts. We will not delete paid user assets solely because a tier or provider changes, and upgrades create new versions rather than replacing old ones.</p>
      </section>

      <section>
        <h2>8. Account deletion</h2>
        <p>You may delete fighters or your account. Account deletion removes Insert Player cloud assets, active account rows, and the reusable Stripe Customer profile/payment methods through the account lifecycle process. Pseudonymized consent evidence, historical Stripe transactions, and legally required accounting records may remain for their stated retention period.</p>
      </section>

      <section>
        <h2>9. Liability and mandatory rights</h2>
        <p>The service is provided with reasonable care but without a guarantee that every AI result will meet your creative expectations. To the maximum extent permitted by law, we are not liable for indirect or consequential losses. Nothing in these terms excludes liability that cannot legally be excluded or limits mandatory consumer, data-protection, or digital-content conformity rights.</p>
      </section>

      <section>
        <h2>10. Governing law and contact</h2>
        <p>Spanish law governs these terms. Consumers keep any mandatory rights and court options provided by the law of their country of residence. Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> before starting a dispute so we can try to resolve it.</p>
      </section>
    </>
  );
}

function CancellationAndRemediesPolicy() {
  return (
    <>
      <header className="legal-page__intro">
        <p className="gallery-eyebrow">Digital Performance</p>
        <h1>Cancellations &amp; Remedies</h1>
        <p>There are no voluntary refunds after external AI processing begins. Mandatory consumer remedies remain available where they apply.</p>
      </header>

      <section>
        <h2>Before external processing</h2>
        <p>Insert Player first reserves the displayed credits. If the request is rejected, conflicts with an existing job, or cannot reach external AI processing, the unused reservation is released. This is not a refund of inference spend because no provider request was started.</p>
      </section>

      <section>
        <h2>After external processing begins</h2>
        <p>The displayed credits are consumed when the first external AI request begins. They are not automatically restored if a provider returns an error, a job is delayed, an output is not to your taste, or the output needs further work. Insert Player may retry idempotently or provide a controlled repair without charging the same generation again.</p>
      </section>

      <section>
        <h2>Credit packs and change of mind</h2>
        <p>Credit packs are delivered immediately and are not voluntarily refundable because you change your mind. If a mandatory withdrawal right still applies to an unused pack, or the law requires a proportionate remedy, Insert Player will honour it. Any payment reversal removes the corresponding credits; if they were already spent, the wallet may become negative.</p>
      </section>

      <section>
        <h2>Non-delivery or lack of conformity</h2>
        <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the address on your Insert Player account and include the fighter or Checkout reference involved. The primary remedy is to put the digital service in conformity through repair or controlled re-performance. A price reduction, payment refund, or other remedy is available only when required by applicable law or approved for a duplicated or incorrect charge.</p>
      </section>

      <section>
        <h2>Account deletion</h2>
        <p>Deleting an account does not create a refund right or convert an unused credit balance into cash. Request any mandatory remedy before deleting the account so we can verify the purchase, generation history, and balance.</p>
      </section>
    </>
  );
}

export function LegalPage({ kind, backLabel = 'Back to game', onBack, onNavigate }: LegalPageProps) {
  return (
    <main className="legal-page">
      <div className="legal-page__toolbar">
        <button className="gallery-back" onClick={onBack}>{backLabel}</button>
        <nav aria-label="Legal documents">
          <a
            href="/legal"
            aria-current={kind === 'legal' ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate('/legal'); }}
          >Legal Notice</a>
          <a
            href="/privacy"
            aria-current={kind === 'privacy' ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate('/privacy'); }}
          >Privacy</a>
          <a
            href="/terms"
            aria-current={kind === 'terms' ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate('/terms'); }}
          >Terms</a>
          <a
            href="/refunds"
            aria-current={kind === 'refunds' ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate('/refunds'); }}
          >Cancellations</a>
        </nav>
      </div>

      <article className="legal-page__document">
        {kind === 'legal'
          ? <LegalNotice />
          : kind === 'privacy'
            ? <PrivacyPolicy />
            : kind === 'terms'
              ? <TermsOfService />
              : <CancellationAndRemediesPolicy />}
        <p className="legal-page__updated">Effective {LEGAL_EFFECTIVE_DATE} · {PUBLIC_ORIGIN}</p>
      </article>
    </main>
  );
}
