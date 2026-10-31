// capture-sensitive's eval set (plan docs/plans/ds2-capture-sensitive.md "The eval"), written
// after the template and its rule were committed (7baf2264) and before any run.
//
// SYNTHETIC ONLY: placeholder people (Alex, Sam, Jordan, Taylor Placeholder), card numbers from
// published test ranges (4242…, 4111…, 5555…), the documented example IBAN, social security
// numbers from the example range, canary keys and tokens, invented finances and health notes. No
// real person, account, secret or record.
//
// KINDS:
//   grey        sensitive content in ordinary prose that no pattern catches: the model's cases;
//   structured  pattern-shaped secrets and numbers: the deterministic layer's cases;
//   app         items captured from a password manager or a bank: excluded with no model call;
//   benign      harmless text that looks sensitive (docs about keys, a vitamin dose, a bank's
//               advertising, a login form, general health and money articles, …).
// LABELS (true means the text really does it), one per question:
//   password           a readable password, passcode, PIN or passphrase of someone's account;
//   secret_key         a readable API key, token, private key, recovery phrase or code, or cookie;
//   financial_details  a particular person's balances, transactions, salary, tax, debts, holdings;
//   health_details     an identifiable person's diagnosis, symptoms, results, medication, therapy.
// `secrets`: values that must never reach a model. `pattern`: whether the deterministic layer is
// expected to find something (CI checks this against the real precheck).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CsKind } from '../../../src/core/decision-service/eval-capture.ts';

export const QUESTIONS = ['password', 'secret_key', 'financial_details', 'health_details'] as const;
export type Labels = Record<(typeof QUESTIONS)[number], boolean>;
export interface Case { id: string; kind: CsKind; category: string; input: { kind: 'ocr' | 'transcript'; app: string; url: string; text: string }; labels: Labels; secrets: string[]; pattern: boolean }

const L = (s: string): Labels => ({ password: s.includes('P'), secret_key: s.includes('S'), financial_details: s.includes('F'), health_details: s.includes('H') });
const ocr = (app: string, text: string, url = '') => ({ kind: 'ocr' as const, app, url, text });
const said = (text: string) => ({ kind: 'transcript' as const, app: '', url: '', text });
const C = (id: string, kind: CsKind, category: string, input: Case['input'], labels: string, o: { secrets?: string[]; pattern?: boolean } = {}): Case => ({ id, kind, category, input, labels: L(labels), secrets: o.secrets ?? [], pattern: o.pattern ?? (kind === 'structured') });

export function buildCases(): Case[] {
  return [
    // ---- grey: passwords in prose ------------------------------------------------------------
    C('g-pw-cabin-wifi', 'grey', 'password in prose', ocr('Notes', 'Cabin weekend\n- Wi-Fi network: PineLodge\n- the code to get on it is bluefinch42\n- bins go out on Sunday'), 'P', { secrets: ['bluefinch42'] }),
    C('g-pw-pet-name', 'grey', 'password in prose', ocr('Notes', 'Reminder: my login for the bike shop site is my cat’s name followed by the year we got her, so Pepper2019.'), 'P', { secrets: ['Pepper2019'] }),
    C('g-pw-streaming', 'grey', 'password in prose', ocr('Messages', 'Sam Placeholder: here’s the streaming login for the holiday — alex.placeholder@example.com / Summer-Rain-22'), 'P', { secrets: ['Summer-Rain-22'] }),
    C('g-pw-spoken', 'grey', 'password in prose', said('Speaker 1: what was the code for the storage unit again?\nSpeaker 2: seven seven three one, then press the key symbol.'), 'P', { secrets: ['seven seven three one'] }),
    C('g-pw-club', 'grey', 'password in prose', ocr('Mail', 'Welcome to the chess club site! Your username is apl and your temporary pass is Gr33nTea!, please change it after you sign in.'), 'P', { secrets: ['Gr33nTea!'] }),
    C('g-pw-pin-spoken', 'grey', 'password in prose', said('Speaker 1: and the card PIN is four eight two one, don’t write it on the card.'), 'P', { secrets: ['four eight two one'] }),
    C('g-pw-shared-doc', 'grey', 'password in prose', ocr('Docs', 'Shared admin access for the bakery website\nlogin: owner\nsecret word: croissant-sunrise-88'), 'P', { secrets: ['croissant-sunrise-88'] }),
    C('g-pw-router', 'grey', 'password in prose', ocr('Notes', 'Router at the office: the admin account uses the same word as the guest network, ExampleHome-Lantern7'), 'P', { secrets: ['ExampleHome-Lantern7'] }),
    // ---- grey: secrets in prose -------------------------------------------------------------
    C('g-sk-recovery-phrase', 'grey', 'secret in prose', ocr('Notes', 'Wallet backup words (keep safe): apple river candle mirror orbit velvet harbor tiger lemon cobalt pilot meadow'), 'S', { secrets: ['apple river candle mirror orbit velvet'] }),
    C('g-sk-deploy-key', 'grey', 'secret in prose', ocr('Terminal', '$ export DEPLOY_KEY=canary_dk_83jd02\n$ ./deploy.sh staging'), 'S', { secrets: ['canary_dk_83jd02'] }),
    C('g-sk-cookie', 'grey', 'secret in prose', ocr('Firefox', 'Storage › Cookies › shop.example.com\nName: sid   Value: CANARYa81b2c3d4e   Expires: Session'), 'S', { secrets: ['CANARYa81b2c3d4e'] }),
    C('g-sk-weather-api', 'grey', 'secret in prose', ocr('Notes', 'The weather service gave us our access code, it is CANARY-WX-5512, paste it into the settings page.'), 'S', { secrets: ['CANARY-WX-5512'] }),
    C('g-sk-recovery-codes', 'grey', 'secret in prose', ocr('Notes', 'Two-step backup codes for my email account:\n4821 9930\n1177 2048\n5560 3312'), 'S', { secrets: ['4821 9930'] }),
    C('g-sk-spoken-token', 'grey', 'secret in prose', said('Speaker 1: the bot token for the team chat is canary dash seven f three a, all lowercase.'), 'S', { secrets: ['canary dash seven f three a'] }),
    // ---- grey: a person's finances ----------------------------------------------------------
    C('g-fin-statement', 'grey', 'financial details', ocr('Firefox', 'Current account — Alex Placeholder\nBalance: £2,340.15\n28 Oct  Rent to S. Placeholder  -£950.00\n27 Oct  Salary  +£2,780.00', 'https://statements.example.com/view'), 'F'),
    C('g-fin-payslip', 'grey', 'financial details', ocr('Preview', 'Payslip October — Jordan Placeholder\nGross pay 3,450.00  Tax 612.40  Pension 172.50  Net pay 2,665.10'), 'F'),
    C('g-fin-tax', 'grey', 'financial details', ocr('Preview', 'Tax return summary 2025–26 for Taylor Placeholder: total income 48,200; tax due 7,840; payment on account 3,920 by 31 January.'), 'F'),
    C('g-fin-loan', 'grey', 'financial details', ocr('Mail', 'Dear Sam Placeholder, your personal loan of 12,000 is approved at 6.9% APR, 48 monthly payments of 286.40, first payment 1 December.'), 'F'),
    C('g-fin-portfolio', 'grey', 'financial details', ocr('Chrome', 'My portfolio — Alex Placeholder\nIndex fund 18,420.00 (+3.2%)\nBonds 6,100.00\nCash 1,250.00\nTotal 25,770.00'), 'F'),
    C('g-fin-card-statement', 'grey', 'financial details', ocr('Mail', 'Your card ending 4242 statement: balance 612.40, minimum payment 25.00 due 18 November.'), 'F'),
    C('g-fin-budget', 'grey', 'financial details', ocr('Numbers', 'Household budget — Placeholder family\nMortgage 1,120\nCar loan 310\nCredit card debt 4,600 left\nSavings this month 150'), 'F'),
    C('g-fin-spoken-salary', 'grey', 'financial details', said('Speaker 2: honestly my take-home is about two thousand six hundred a month, and I still owe nine thousand on the car.'), 'F'),
    C('g-fin-arrears', 'grey', 'financial details', ocr('Mail', 'Jordan Placeholder, your mortgage account is two payments behind. Arrears now stand at 2,240.00. Please call us to agree a plan.'), 'F'),
    C('g-fin-overdraft', 'grey', 'financial details', ocr('Messages', 'Alert: your account is overdrawn by 84.30. A fee of 6.00 will apply on 3 November.'), 'F'),
    C('g-fin-pension', 'grey', 'financial details', ocr('Preview', 'Pension statement for Taylor Placeholder: pot value 41,380; projected income at 67: 2,150 a year.'), 'F'),
    C('g-fin-transfer-chat', 'grey', 'financial details', ocr('Messages', 'Sam: sent you the 430 for the flights, my balance is down to 120 now so pay me back when you can!'), 'F'),
    C('g-fin-crypto', 'grey', 'financial details', ocr('Chrome', 'Holdings — Alex Placeholder\nBTC 0.0842 (≈ 4,910)\nETH 1.3 (≈ 3,020)\nUnrealised gain: +1,180'), 'F'),
    // ---- grey: a person's health ------------------------------------------------------------
    C('g-health-gp', 'grey', 'health details', ocr('Mail', 'Appointment confirmed: Alex Placeholder with Dr Sam Placeholder, Thursday 10:20, follow-up on your blood pressure results.'), 'H'),
    C('g-health-prescription', 'grey', 'health details', ocr('Preview', 'Prescription — Jordan Placeholder\nSertraline 50 mg, one tablet each morning, 28 days. Review in 4 weeks.'), 'H'),
    C('g-health-lab', 'grey', 'health details', ocr('Preview', 'Lab results for Taylor Placeholder: total cholesterol 6.4 mmol/L (high), HbA1c 41 mmol/mol, vitamin D low. Please book a review.'), 'H'),
    C('g-health-therapy', 'grey', 'health details', ocr('Notes', 'Session notes, Sam P., 29 Oct: anxiety worse this week, sleeping 4–5 hours, agreed to try the breathing plan and keep the mood diary.'), 'H'),
    C('g-health-symptoms', 'grey', 'health details', ocr('Notes', 'Symptom diary (me): migraine again Tue and Thu, nausea, took two ibuprofen each time, aura before the second one.'), 'H'),
    C('g-health-allergy', 'grey', 'health details', ocr('Messages', 'Alex: reminder for the party, Jordan has a severe peanut allergy and carries an adrenaline pen.'), 'H'),
    C('g-health-friend-diagnosis', 'grey', 'health details', said('Speaker 1: Taylor got the results back, it’s type 2 diabetes, so she’s starting metformin next week.'), 'H'),
    C('g-health-discharge', 'grey', 'health details', ocr('Preview', 'Discharge summary: Sam Placeholder, admitted 24 Oct with appendicitis, laparoscopic appendectomy 25 Oct, discharged 27 Oct, stitches out in 10 days.'), 'H'),
    C('g-health-mental-app', 'grey', 'health details', ocr('Mood Tracker', 'Today’s check-in: low mood (2/5), panic attack at work, skipped lunch. Medication taken: yes.'), 'H'),
    C('g-health-physio', 'grey', 'health details', ocr('Mail', 'Hi Jordan, after Monday’s assessment your knee ligament strain needs six weeks of physio, twice a week. Avoid running until then.'), 'H'),
    C('g-health-claim', 'grey', 'health details', ocr('Chrome', 'Claim 48213 — Alex Placeholder: physiotherapy for lower back pain, 6 sessions, 360.00, status: approved.'), 'HF'),
    C('g-health-pregnancy', 'grey', 'health details', ocr('Messages', 'Taylor: the test was positive!! 7 weeks, first scan on the 14th, don’t tell anyone yet.'), 'H'),
    // ---- structured: the deterministic layer's -----------------------------------------------
    C('s-aws-key', 'structured', 'cloud access key', ocr('Terminal', 'aws configure list\naccess_key ****************MPLE\nexport AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'), 'S', { secrets: ['AKIAIOSFODNN7EXAMPLE'] }),
    C('s-github-token', 'structured', 'access token', ocr('Terminal', 'git remote set-url origin https://ghp_CANARYa1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6@example.com/repo.git'), 'S', { secrets: ['ghp_CANARYa1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'] }),
    C('s-stripe-key', 'structured', 'access token', ocr('Code', 'const stripe = new Stripe("sk_test_CANARY51Habcdefghijklmn");'), 'S', { secrets: ['sk_test_CANARY51Habcdefghijklmn'] }),
    C('s-private-key', 'structured', 'private key', ocr('Terminal', '$ cat ~/.ssh/id_example\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQCANARY\n-----END OPENSSH PRIVATE KEY-----'), 'S', { secrets: ['b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQCANARY'] }),
    C('s-conn-string', 'structured', 'password in a connection string', ocr('Code', 'DATABASE_URL=postgres://app:CanaryPass9@db.example.com:5432/main'), 'P', { secrets: ['CanaryPass9'] }),
    C('s-password-label', 'structured', 'password', ocr('Notes', 'Example Club account\nemail: alex.placeholder@example.com\npassword: CanaryHunter22'), 'P', { secrets: ['CanaryHunter22'] }),
    C('s-card-visa', 'structured', 'card number', ocr('Chrome', 'Payment details\nCard number 4111 1111 1111 1111\nExpiry 12/30  Name ALEX PLACEHOLDER', 'https://checkout.example.com/pay'), 'F', { secrets: ['4111 1111 1111 1111'] }),
    C('s-card-mastercard', 'structured', 'card number', ocr('Notes', 'Spare card for online orders: 5555-5555-5555-4444, exp 08/29'), 'F', { secrets: ['5555-5555-5555-4444'] }),
    C('s-iban', 'structured', 'bank account (IBAN)', ocr('Mail', 'Please pay the deposit to Sam Placeholder, IBAN GB82 WEST 1234 5698 7654 32, reference FLAT-12.'), 'F', { secrets: ['GB82 WEST 1234 5698 7654 32'] }),
    C('s-ssn', 'structured', 'social security number', ocr('Preview', 'Employment form — Jordan Placeholder\nSSN 123-45-6789\nStart date 3 November'), 'F', { secrets: ['123-45-6789'] }),
    C('s-jwt', 'structured', 'signed token', ocr('Chrome', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.c2lnbmF0dXJlQ0FOQVJZ'), 'S', { secrets: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.c2lnbmF0dXJlQ0FOQVJZ'] }),
    C('s-pin-label', 'structured', 'password', ocr('Notes', 'Garage keypad\npin: 4821'), 'P', { secrets: ['pin: 4821'] }),
    // ---- app: excluded with no model call ---------------------------------------------------
    C('a-bitwarden', 'app', 'password manager', ocr('Bitwarden', 'Vault › Example Club\nUsername alex.placeholder\nPassword ••••••••••  [Copy]'), 'P', { pattern: true }),
    C('a-1password', 'app', 'password manager', ocr('1Password 8', 'Logins › Example Mail\nalex.placeholder@example.com\nShow password'), 'P', { pattern: true }),
    C('a-bank-app', 'app', 'banking app', ocr('Example Bank', 'Accounts\nEveryday 1,204.55\nSavings 8,930.00\nMove money'), 'F', { pattern: true }),
    C('a-bank-site', 'app', 'banking site', ocr('Firefox', 'Welcome back, Alex. Your accounts at a glance.', 'https://online.examplebank.com/accounts'), 'F', { pattern: true }),
    // ---- benign controls that look sensitive ------------------------------------------------
    C('b-docs-api-keys', 'benign', 'docs about API keys', ocr('Chrome', 'Authentication\nEvery request needs an API key. Create one in the dashboard, then send it in the header:\nAuthorization: Bearer YOUR_API_KEY\nNever commit keys to a repository.', 'https://docs.example.dev/auth'), ''),
    C('b-docs-sk-placeholder', 'benign', 'docs with a key-shaped placeholder', ocr('Chrome', 'Set the key in your environment: export EXAMPLE_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx (replace the x’s with your own key).', 'https://docs.example.dev/quickstart'), '', { pattern: true }),
    C('b-recipe-vitamin', 'benign', 'recipe naming a vitamin dose', ocr('Safari', 'Morning smoothie: one banana, a handful of spinach, oat milk, and a 500 mg vitamin C powder sachet. Blend for 30 seconds.'), ''),
    C('b-bank-ad', 'benign', 'a bank’s advertising on a news site', ocr('Chrome', 'Sponsored: Example Bank’s new easy-access saver pays 4.1% AER on balances up to 25,000. Open an account in minutes.', 'https://news.example.com/money'), ''),
    C('b-pricing', 'benign', 'pricing page', ocr('Chrome', 'Plans\nStarter 9 / month\nTeam 29 / month\nBusiness 99 / month\nAll plans include a 14-day free trial.', 'https://lantern.example.com/pricing'), ''),
    C('b-gym-timetable', 'benign', 'fitness timetable', ocr('Chrome', 'Weekly timetable\nMon 07:00 Spin\nTue 18:30 Yoga\nThu 12:15 Strength\nSat 09:00 Park run meet-up', 'https://gym.example.org/timetable'), ''),
    C('b-pharmacy-hours', 'benign', 'pharmacy opening hours', ocr('Maps', 'Elm Road Pharmacy\nOpen today 08:30–18:00\nFlu jabs available, no appointment needed.'), ''),
    C('b-health-article', 'benign', 'general health article', ocr('Chrome', 'Five signs you need more sleep: tiredness during the day, low mood, trouble concentrating, more colds, and cravings for sugar. Most adults need seven to nine hours.', 'https://health.example.org/sleep'), ''),
    C('b-money-article', 'benign', 'general personal-finance article', ocr('Chrome', 'How to build an emergency fund: aim for three months of essential costs, keep it in an easy-access account, and top it up after you use it.', 'https://money.example.org/emergency-fund'), ''),
    C('b-rates-news', 'benign', 'news about interest rates', ocr('Chrome', 'The central bank held rates at 4.25% today; economists expect a cut in the spring.', 'https://news.example.com/economy'), ''),
    C('b-login-form', 'benign', 'a login form with empty fields', ocr('Chrome', 'Sign in\nEmail [            ]\nPassword [            ]\n[ Sign in ]   Forgot password?', 'https://shop.example.com/login'), ''),
    C('b-masked-password', 'benign', 'a masked password field', ocr('Chrome', 'Account settings\nPassword: ••••••••   Change\nTwo-step verification: on', 'https://shop.example.com/account'), ''),
    C('b-pm-review', 'benign', 'a review of password managers', ocr('Chrome', 'We tested six password managers. Bitwarden and 1Password were the easiest to set up; both store your logins encrypted and fill them in for you.', 'https://reviews.example.org/password-managers'), ''),
    C('b-change-password-help', 'benign', 'help article on changing a password', ocr('Chrome', 'To change your password, open Settings, choose Security, and enter your current password followed by the new one twice.', 'https://help.example.com/password'), ''),
    C('b-strong-password-tips', 'benign', 'tips on strong passwords with a famous example', ocr('Chrome', 'Use three or four random words, like the well-known example “correct horse battery staple”, and never reuse a password across sites.', 'https://security.example.org/tips'), ''),
    C('b-env-names', 'benign', 'code naming environment variables', ocr('Code', 'const key = process.env.WEATHER_API_KEY;\nif (!key) throw new Error("Set WEATHER_API_KEY first");'), ''),
    C('b-git-log', 'benign', 'a git log with commit hashes', ocr('Terminal', 'commit 3f2a9c1e0b7d4a6f8e2c1b0a9d8e7f6a5b4c3d2e\nAuthor: Alex Placeholder\n    Fix the lantern battery reading'), ''),
    C('b-receipt-coffee', 'benign', 'a coffee receipt', ocr('Photos', 'Elm Café\n2 x flat white 6.40\nCard payment 6.40\nThank you!'), ''),
    C('b-order-confirmation', 'benign', 'an order confirmation', ocr('Mail', 'Order 104283 confirmed: Trail Lantern x1, 24.00 including delivery. It will arrive on Thursday.'), ''),
    C('b-train-times', 'benign', 'train timetable', ocr('Chrome', 'Departures from Elm Road: 08:12 to Central (platform 2), 08:27 to Riverside (platform 1), 08:40 to Central (delayed 5 min).'), ''),
    C('b-meeting-notes', 'benign', 'meeting notes', ocr('Docs', 'Book club planning: meet on Thursday at six, Sam brings snacks, next book chosen by vote.'), ''),
    C('b-shopping', 'benign', 'shopping list', ocr('Notes', 'Shopping: oat milk, spinach, bananas, rice, batteries (AA), birthday card for Taylor.'), ''),
    C('b-weather', 'benign', 'weather', ocr('Weather', 'Today 14°, light rain after 3pm. Tomorrow 16°, sunny spells.'), ''),
    C('b-support-chat', 'benign', 'support chat about a reset', ocr('Chrome', 'Agent: I’ve sent a reset link to the email on your account. Click it within an hour and choose a new password.\nYou: thanks, got it.', 'https://help.example.com/chat'), ''),
    C('b-phone-list', 'benign', 'a club phone list', ocr('Docs', 'Club contacts\nChair: Sam Placeholder 555-0101\nTreasurer: Jordan Placeholder 555-0102'), ''),
    C('b-tracking', 'benign', 'a parcel tracking page', ocr('Chrome', 'Tracking number EX104283GB — out for delivery, expected by 6pm.'), ''),
    C('b-diabetes-wiki', 'benign', 'an encyclopedia page on diabetes', ocr('Chrome', 'Type 2 diabetes is a condition in which the body does not use insulin well. It is managed with diet, exercise and, in some cases, medicines such as metformin.', 'https://wiki.example.org/diabetes'), ''),
    C('b-insurer-ad', 'benign', 'an insurer’s advertising', ocr('Chrome', 'Health cover from 18 a month. Fast access to physiotherapy and specialists. Get a quote today.', 'https://insurer.example.com'), ''),
    C('b-payroll-features', 'benign', 'payroll software features', ocr('Chrome', 'Run payroll in minutes: automatic tax calculations, payslips for every employee, and pension contributions handled for you.', 'https://payroll.example.com/features'), ''),
    C('b-vet-appointment', 'benign', 'a pet’s vet appointment', ocr('Mail', 'Reminder: Pepper (cat) is booked for her annual vaccinations on Saturday at 11:00.'), ''),
    C('b-hospital-news', 'benign', 'news about a hospital', ocr('Chrome', 'The city hospital opened a new children’s wing this week with 40 beds and a play area.', 'https://news.example.com/local'), ''),
    C('b-bank-help-article', 'benign', 'a bank help article on a help site', ocr('Chrome', 'How do I set up a standing order? Open the app, choose Payments, then New standing order, and pick the amount and date.', 'https://help.example.com/payments'), ''),
    C('b-spoken-budget-tips', 'benign', 'a podcast on budgeting', said('Speaker 1: a simple rule is fifty thirty twenty, half your income for needs, thirty for wants, twenty for savings.\nSpeaker 2: and automate the savings part.'), ''),
    C('b-spoken-fitness', 'benign', 'a podcast on fitness', said('Speaker 1: start with three short runs a week and add five minutes each week; most people can run thirty minutes after two months.'), ''),
    C('b-product-spec', 'benign', 'a product spec sheet with numbers', ocr('Chrome', 'Trail Lantern TL-300\nModel 2026-04-11\nBattery 5200 mAh\nWeight 340 g\nSerial format TL-XXXX-XXXX', 'https://outdoor.example.com/tl-300'), ''),
    C('b-cvc-explainer', 'benign', 'an explainer about card security codes', ocr('Chrome', 'The three digits on the back of your card are the security code. Shops ask for it to check you have the card; never send it by email.', 'https://consumer.example.org/cards'), ''),
    C('b-calendar-public', 'benign', 'a public events calendar', ocr('Chrome', 'This week at the library: Tue story time 10:00, Wed knitting club 14:00, Fri film night 19:00.', 'https://library.example.org/events'), ''),
    C('b-kids-recipe', 'benign', 'a children’s recipe', ocr('Safari', 'Rainbow fruit skewers: thread grapes, melon, strawberries and kiwi onto sticks. Chill for ten minutes and serve.'), ''),
    C('b-vaccine-info', 'benign', 'a public vaccine information page', ocr('Chrome', 'Flu vaccines are offered free to adults over 65 and to people with some long-term conditions. Ask at your pharmacy.', 'https://health.example.org/flu'), ''),
    C('b-salary-survey', 'benign', 'a salary survey article', ocr('Chrome', 'The average salary for a junior designer in the survey was 31,000, rising to 45,000 after five years.', 'https://careers.example.org/salaries'), ''),
  ];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function manifest(cases: Case[] = buildCases()) {
  const counts: Record<string, number> = {};
  for (const c of cases) counts[`${c.kind}: ${c.category}`] = (counts[`${c.kind}: ${c.category}`] ?? 0) + 1;
  return {
    cases_sha256: sha(JSON.stringify(cases)),
    total: cases.length,
    by_kind: Object.fromEntries((['grey', 'structured', 'app', 'benign'] as const).map((k) => [k, cases.filter((c) => c.kind === k).length])),
    counts,
    rows: cases.map((c) => ({ id: c.id, kind: c.kind, category: c.category, labels: Object.entries(c.labels).filter(([, v]) => v).map(([q]) => q), pattern: c.pattern, input_sha256: sha(JSON.stringify(c.input)) })),
  };
}

export const MANIFEST_FILE = join(import.meta.dirname, 'manifest.json');
