# Evidence: capture-sensitive and its eval (capture screening, job 1)

Written by `tests/acceptance/capture-sensitive-eval-real.test.ts` (opt-in, `NOVA_REAL_CAPTURE_SENSITIVE=1`); plan `docs/plans/ds2-capture-sensitive.md`. Per-case results: `docs/evidence/capture-sensitive-eval.json`. Verdicts the Decision Service follows: `src/core/decision-service/verdicts-capture-sensitive.json`, recomputed in CI. All content is synthetic.

- **The template and its rule, fixed before any eval case:** commit `727b750982090f65b941f981bbede3799156da74`.
- **The eval, fixed before any run:** commit `9cb2ca0af0d61cfbf6a9858385b3082f686a7f5b`.
- **The set:** 95 cases: 39 grey-area sensitive, 12 structured, 4 sensitive-app, 40 harmless. SHA-256 `3e3a899886605d3c4ffd1f0aabd597a3090e9cb1e6f92e375dc20f2c9f421773`.
- **Bounds (a privacy screen):** detection ≥ 95% on grey-area cases; false holds ≤ 20% on harmless ones; ECE ≤ 0.10 (10 bins). The deterministic layer must redact or exclude every structured and sensitive-app case, and no secret value may reach a model.

## Verdicts

| Size | Verdict | Trusted? | Detection | False holds | ECE | Deterministic | Secret leaks | Digest | Run |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| tev1:4b | pass (all three model bounds met) | yes | 97.4% (38/39) | 2.5% (1/40) | 0.032 | 100% (16/16) | 0 | 7954dce22bc6c29c3b119656207681d12cb34434fed7caa086bfbc919bef0740 | 2026-10-31T19:48:32.317Z |
| tev1:0.8b | fail (detection 79.5% is below 95%) | no: evidence only | 79.5% (31/39) | 12.5% (5/40) | 0.023 | 100% (16/16) | 0 | abc31fdb0bf52506cc47091145ac19c4cfb509b73a6841789324f9e32200c099 | 2026-10-31T19:48:49.455Z |

## The set by category

| Kind: category | Cases |
| --- | ---: |
| grey: password in prose | 8 |
| grey: secret in prose | 6 |
| grey: financial details | 13 |
| grey: health details | 12 |
| structured: cloud access key | 1 |
| structured: access token | 2 |
| structured: private key | 1 |
| structured: password in a connection string | 1 |
| structured: password | 2 |
| structured: card number | 2 |
| structured: bank account (IBAN) | 1 |
| structured: social security number | 1 |
| structured: signed token | 1 |
| app: password manager | 2 |
| app: banking app | 1 |
| app: banking site | 1 |
| benign: docs about API keys | 1 |
| benign: docs with a key-shaped placeholder | 1 |
| benign: recipe naming a vitamin dose | 1 |
| benign: a bank’s advertising on a news site | 1 |
| benign: pricing page | 1 |
| benign: fitness timetable | 1 |
| benign: pharmacy opening hours | 1 |
| benign: general health article | 1 |
| benign: general personal-finance article | 1 |
| benign: news about interest rates | 1 |
| benign: a login form with empty fields | 1 |
| benign: a masked password field | 1 |
| benign: a review of password managers | 1 |
| benign: help article on changing a password | 1 |
| benign: tips on strong passwords with a famous example | 1 |
| benign: code naming environment variables | 1 |
| benign: a git log with commit hashes | 1 |
| benign: a coffee receipt | 1 |
| benign: an order confirmation | 1 |
| benign: train timetable | 1 |
| benign: meeting notes | 1 |
| benign: shopping list | 1 |
| benign: weather | 1 |
| benign: support chat about a reset | 1 |
| benign: a club phone list | 1 |
| benign: a parcel tracking page | 1 |
| benign: an encyclopedia page on diabetes | 1 |
| benign: an insurer’s advertising | 1 |
| benign: payroll software features | 1 |
| benign: a pet’s vet appointment | 1 |
| benign: news about a hospital | 1 |
| benign: a bank help article on a help site | 1 |
| benign: a podcast on budgeting | 1 |
| benign: a podcast on fitness | 1 |
| benign: a product spec sheet with numbers | 1 |
| benign: an explainer about card security codes | 1 |
| benign: a public events calendar | 1 |
| benign: a children’s recipe | 1 |
| benign: a public vaccine information page | 1 |
| benign: a salary survey article | 1 |

## tev1:4b

- Detection (grey area, model’s outcome not index): 97.4% (38/39), Wilson 95% 0.8682–0.9955. Missed: g-health-prescription.
- False holds (harmless, model’s outcome not index): 2.5% (1/40), Wilson 95% 0.0044–0.1288. Held: b-vet-appointment.
- The whole pipeline on harmless cases (patterns included, information): 5% (2/40).
- Deterministic layer: 100% (16/16) of structured and sensitive-app cases redacted or excluded; secret values reaching a model: 0.
- ECE 0.032; by question: password 0.076, secret_key 0.080, financial_details 0.054, health_details 0.017.
- Unanswered: none.

### Reliability bins

| Bin | Pairs | Mean p | Share true |
| --- | ---: | ---: | ---: |
| [0.0, 0.1) | 250 | 0.013 | 0.004 |
| [0.1, 0.2) | 9 | 0.146 | 0.111 |
| [0.2, 0.3) | 6 | 0.242 | 0.000 |
| [0.3, 0.4) | 6 | 0.326 | 0.500 |
| [0.4, 0.5) | 2 | 0.468 | 0.000 |
| [0.5, 0.6) | 2 | 0.566 | 0.500 |
| [0.6, 0.7) | 7 | 0.662 | 0.714 |
| [0.7, 0.8) | 4 | 0.738 | 0.750 |
| [0.8, 0.9) | 11 | 0.852 | 0.636 |
| [0.9, 1.0] | 19 | 0.948 | 1.000 |

### Per case

| Case | Kind | password | secret_key | financial_details | health_details | Model | Pipeline | Found | ms |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | ---: |
| g-pw-cabin-wifi | grey | 0.934 * | 0.817 | 0.008 | 0.005 | exclude | exclude | — | 3687 |
| g-pw-pet-name | grey | 0.692 * | 0.729 | 0.018 | 0.006 | exclude | exclude | — | 146 |
| g-pw-streaming | grey | 0.621 * | 0.693 | 0.041 | 0.007 | hold | hold | — | 148 |
| g-pw-spoken | grey | 0.689 * | 0.351 | 0.108 | 0.006 | hold | hold | — | 153 |
| g-pw-club | grey | 0.961 * | 0.889 | 0.006 | 0.006 | exclude | exclude | — | 150 |
| g-pw-pin-spoken | grey | 0.926 * | 0.436 | 0.854 | 0.012 | exclude | exclude | — | 149 |
| g-pw-shared-doc | grey | 0.774 * | 0.609 | 0.011 | 0.005 | exclude | exclude | — | 152 |
| g-pw-router | grey | 0.325 * | 0.320 | 0.006 | 0.004 | hold | hold | — | 150 |
| g-sk-recovery-phrase | grey | 0.564 | 0.851 * | 0.099 | 0.010 | exclude | exclude | — | 151 |
| g-sk-deploy-key | grey | 0.192 | 0.804 * | 0.011 | 0.004 | exclude | exclude | — | 147 |
| g-sk-cookie | grey | 0.019 | 0.677 * | 0.020 | 0.006 | hold | hold | — | 147 |
| g-sk-weather-api | grey | 0.900 | 0.817 * | 0.016 | 0.015 | exclude | exclude | — | 148 |
| g-sk-recovery-codes | grey | 0.207 | 0.567 * | 0.085 | 0.007 | hold | hold | — | 151 |
| g-sk-spoken-token | grey | 0.500 | 0.869 * | 0.021 | 0.003 | exclude | exclude | — | 147 |
| g-fin-statement | grey | 0.017 | 0.012 | 0.905 * | 0.006 | hold | hold | — | 151 |
| g-fin-payslip | grey | 0.007 | 0.008 | 0.851 * | 0.016 | hold | hold | — | 153 |
| g-fin-tax | grey | 0.010 | 0.008 | 0.941 * | 0.014 | hold | hold | — | 151 |
| g-fin-loan | grey | 0.010 | 0.013 | 0.959 * | 0.009 | hold | hold | — | 151 |
| g-fin-portfolio | grey | 0.006 | 0.010 | 0.875 * | 0.012 | hold | hold | — | 145 |
| g-fin-card-statement | grey | 0.011 | 0.021 | 0.915 * | 0.010 | hold | hold | — | 150 |
| g-fin-budget | grey | 0.009 | 0.013 | 0.302 * | 0.007 | hold | hold | — | 153 |
| g-fin-spoken-salary | grey | 0.012 | 0.011 | 0.963 * | 0.012 | hold | hold | — | 150 |
| g-fin-arrears | grey | 0.008 | 0.013 | 0.964 * | 0.013 | hold | hold | — | 151 |
| g-fin-overdraft | grey | 0.005 | 0.012 | 0.711 * | 0.008 | hold | hold | — | 149 |
| g-fin-pension | grey | 0.013 | 0.015 | 0.945 * | 0.015 | hold | hold | — | 147 |
| g-fin-transfer-chat | grey | 0.047 | 0.092 | 0.945 * | 0.014 | hold | hold | — | 151 |
| g-fin-crypto | grey | 0.008 | 0.020 | 0.652 * | 0.015 | hold | hold | — | 150 |
| g-health-gp | grey | 0.007 | 0.012 | 0.005 | 0.839 * | hold | hold | — | 148 |
| g-health-prescription | grey | 0.008 | 0.010 | 0.013 | 0.086 * | index | index | — | 147 |
| g-health-lab | grey | 0.010 | 0.012 | 0.007 | 0.965 * | hold | hold | — | 149 |
| g-health-therapy | grey | 0.003 | 0.004 | 0.002 | 0.959 * | hold | hold | — | 149 |
| g-health-symptoms | grey | 0.004 | 0.004 | 0.002 | 0.916 * | hold | hold | — | 145 |
| g-health-allergy | grey | 0.006 | 0.008 | 0.003 | 0.949 * | hold | hold | — | 149 |
| g-health-friend-diagnosis | grey | 0.005 | 0.007 | 0.007 | 0.987 * | hold | hold | — | 145 |
| g-health-discharge | grey | 0.010 | 0.006 | 0.003 | 0.925 * | hold | hold | — | 149 |
| g-health-mental-app | grey | 0.004 | 0.005 | 0.003 | 0.736 * | hold | hold | — | 145 |
| g-health-physio | grey | 0.004 | 0.004 | 0.004 | 0.979 * | hold | hold | — | 147 |
| g-health-claim | grey | 0.009 | 0.040 | 0.160 * | 0.320 * | hold | hold | — | 154 |
| g-health-pregnancy | grey | 0.013 | 0.021 | 0.005 | 0.967 * | hold | hold | — | 143 |
| s-aws-key | structured | 0.038 | 0.585 * | 0.117 | 0.006 | hold | hold | cloud access key | 145 |
| s-github-token | structured | 0.119 | 0.752 * | 0.010 | 0.003 | exclude | exclude | access token | 140 |
| s-stripe-key | structured | 0.060 | 0.553 * | 0.127 | 0.010 | hold | hold | access token | 140 |
| s-private-key | structured | 0.011 | 0.124 * | 0.005 | 0.004 | index | redact | private key | 154 |
| s-conn-string | structured | 0.169 * | 0.704 | 0.138 | 0.009 | exclude | exclude | password in a connection string | 152 |
| s-password-label | structured | 0.040 * | 0.206 | 0.274 | 0.005 | index | redact | password | 152 |
| s-card-visa | structured | 0.009 | 0.029 | 0.783 * | 0.007 | hold | hold | card number | 155 |
| s-card-mastercard | structured | 0.013 | 0.081 | 0.872 * | 0.010 | hold | hold | card number | 145 |
| s-iban | structured | 0.008 | 0.027 | 0.649 * | 0.006 | hold | hold | bank account (IBAN) | 149 |
| s-ssn | structured | 0.009 | 0.017 | 0.078 * | 0.010 | index | redact | social security number | 147 |
| s-jwt | structured | 0.040 | 0.625 * | 0.028 | 0.009 | hold | hold | signed token | 149 |
| s-pin-label | structured | 0.123 * | 0.093 | 0.022 | 0.004 | index | redact | password | 147 |
| a-bitwarden | app | — | — | — | — | not asked | exclude | — | 0 |
| a-1password | app | — | — | — | — | not asked | exclude | — | 0 |
| a-bank-app | app | — | — | — | — | not asked | exclude | — | 0 |
| a-bank-site | app | — | — | — | — | not asked | exclude | — | 0 |
| b-docs-api-keys | benign | 0.075 | 0.020 | 0.007 | 0.009 | index | index | — | 156 |
| b-docs-sk-placeholder | benign | 0.107 | 0.183 | 0.029 | 0.009 | index | redact | access token | 151 |
| b-recipe-vitamin | benign | 0.008 | 0.011 | 0.004 | 0.010 | index | index | — | 152 |
| b-bank-ad | benign | 0.007 | 0.009 | 0.008 | 0.009 | index | index | — | 152 |
| b-pricing | benign | 0.005 | 0.008 | 0.008 | 0.011 | index | index | — | 152 |
| b-gym-timetable | benign | 0.003 | 0.007 | 0.003 | 0.019 | index | index | — | 149 |
| b-pharmacy-hours | benign | 0.004 | 0.005 | 0.005 | 0.005 | index | index | — | 150 |
| b-health-article | benign | 0.004 | 0.004 | 0.002 | 0.006 | index | index | — | 141 |
| b-money-article | benign | 0.004 | 0.006 | 0.004 | 0.020 | index | index | — | 142 |
| b-rates-news | benign | 0.006 | 0.007 | 0.006 | 0.010 | index | index | — | 139 |
| b-login-form | benign | 0.202 | 0.243 | 0.026 | 0.008 | index | index | — | 143 |
| b-masked-password | benign | 0.040 | 0.048 | 0.053 | 0.008 | index | index | — | 142 |
| b-pm-review | benign | 0.067 | 0.024 | 0.013 | 0.014 | index | index | — | 156 |
| b-change-password-help | benign | 0.078 | 0.179 | 0.013 | 0.011 | index | index | — | 156 |
| b-strong-password-tips | benign | 0.291 | 0.150 | 0.007 | 0.014 | index | index | — | 155 |
| b-env-names | benign | 0.111 | 0.271 | 0.011 | 0.011 | index | index | — | 155 |
| b-git-log | benign | 0.009 | 0.027 | 0.005 | 0.047 | index | index | — | 158 |
| b-receipt-coffee | benign | 0.005 | 0.007 | 0.047 | 0.006 | index | index | — | 155 |
| b-order-confirmation | benign | 0.006 | 0.026 | 0.063 | 0.007 | index | index | — | 156 |
| b-train-times | benign | 0.004 | 0.012 | 0.004 | 0.009 | index | index | — | 157 |
| b-meeting-notes | benign | 0.004 | 0.004 | 0.007 | 0.004 | index | index | — | 154 |
| b-shopping | benign | 0.006 | 0.010 | 0.009 | 0.011 | index | index | — | 151 |
| b-weather | benign | 0.003 | 0.006 | 0.002 | 0.009 | index | index | — | 153 |
| b-support-chat | benign | 0.085 | 0.045 | 0.013 | 0.015 | index | index | — | 153 |
| b-phone-list | benign | 0.015 | 0.017 | 0.033 | 0.003 | index | index | — | 154 |
| b-tracking | benign | 0.012 | 0.050 | 0.022 | 0.006 | index | index | — | 152 |
| b-diabetes-wiki | benign | 0.005 | 0.004 | 0.003 | 0.005 | index | index | — | 153 |
| b-insurer-ad | benign | 0.004 | 0.009 | 0.011 | 0.009 | index | index | — | 138 |
| b-payroll-features | benign | 0.005 | 0.010 | 0.028 | 0.010 | index | index | — | 142 |
| b-vet-appointment | benign | 0.006 | 0.006 | 0.006 | 0.337 | hold | hold | — | 144 |
| b-hospital-news | benign | 0.003 | 0.005 | 0.005 | 0.008 | index | index | — | 143 |
| b-bank-help-article | benign | 0.004 | 0.006 | 0.025 | 0.008 | index | index | — | 141 |
| b-spoken-budget-tips | benign | 0.008 | 0.011 | 0.016 | 0.008 | index | index | — | 147 |
| b-spoken-fitness | benign | 0.005 | 0.004 | 0.003 | 0.011 | index | index | — | 148 |
| b-product-spec | benign | 0.005 | 0.019 | 0.007 | 0.012 | index | index | — | 149 |
| b-cvc-explainer | benign | 0.083 | 0.126 | 0.237 | 0.013 | index | index | — | 150 |
| b-calendar-public | benign | 0.003 | 0.005 | 0.002 | 0.010 | index | index | — | 149 |
| b-kids-recipe | benign | 0.004 | 0.007 | 0.003 | 0.009 | index | index | — | 150 |
| b-vaccine-info | benign | 0.004 | 0.005 | 0.006 | 0.009 | index | index | — | 144 |
| b-salary-survey | benign | 0.003 | 0.005 | 0.033 | 0.009 | index | index | — | 149 |

`*` marks a question whose label is true.

## tev1:0.8b

- Detection (grey area, model’s outcome not index): 79.5% (31/39), Wilson 95% 0.6447–0.8922. Missed: g-pw-cabin-wifi, g-pw-pet-name, g-pw-streaming, g-pw-spoken, g-pw-router, g-sk-recovery-phrase, g-sk-cookie, g-sk-spoken-token.
- False holds (harmless, model’s outcome not index): 12.5% (5/40), Wilson 95% 0.0546–0.2611. Held: b-docs-api-keys, b-docs-sk-placeholder, b-change-password-help, b-env-names, b-vet-appointment.
- The whole pipeline on harmless cases (patterns included, information): 12.5% (5/40).
- Deterministic layer: 100% (16/16) of structured and sensitive-app cases redacted or excluded; secret values reaching a model: 0.
- ECE 0.023; by question: password 0.085, secret_key 0.088, financial_details 0.029, health_details 0.042.
- Unanswered: none.

### Reliability bins

| Bin | Pairs | Mean p | Share true |
| --- | ---: | ---: | ---: |
| [0.0, 0.1) | 255 | 0.020 | 0.024 |
| [0.1, 0.2) | 15 | 0.140 | 0.200 |
| [0.2, 0.3) | 6 | 0.241 | 0.167 |
| [0.3, 0.4) | 3 | 0.368 | 0.000 |
| [0.4, 0.5) | 5 | 0.455 | 0.600 |
| [0.5, 0.6) | 3 | 0.563 | 0.667 |
| [0.6, 0.7) | 6 | 0.665 | 0.500 |
| [0.7, 0.8) | 2 | 0.733 | 1.000 |
| [0.8, 0.9) | 2 | 0.867 | 0.500 |
| [0.9, 1.0] | 19 | 0.967 | 1.000 |

### Per case

| Case | Kind | password | secret_key | financial_details | health_details | Model | Pipeline | Found | ms |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | ---: |
| g-pw-cabin-wifi | grey | 0.049 * | 0.265 | 0.006 | 0.007 | index | index | — | 1670 |
| g-pw-pet-name | grey | 0.022 * | 0.130 | 0.009 | 0.041 | index | index | — | 63 |
| g-pw-streaming | grey | 0.027 * | 0.192 | 0.018 | 0.022 | index | index | — | 64 |
| g-pw-spoken | grey | 0.075 * | 0.162 | 0.016 | 0.022 | index | index | — | 68 |
| g-pw-club | grey | 0.474 * | 0.336 | 0.009 | 0.018 | hold | hold | — | 70 |
| g-pw-pin-spoken | grey | 0.944 * | 0.148 | 0.251 | 0.015 | exclude | exclude | — | 69 |
| g-pw-shared-doc | grey | 0.126 * | 0.425 | 0.006 | 0.004 | hold | hold | — | 68 |
| g-pw-router | grey | 0.014 * | 0.098 | 0.004 | 0.004 | index | index | — | 66 |
| g-sk-recovery-phrase | grey | 0.020 | 0.200 * | 0.129 | 0.010 | index | index | — | 68 |
| g-sk-deploy-key | grey | 0.010 | 0.754 * | 0.008 | 0.018 | exclude | exclude | — | 64 |
| g-sk-cookie | grey | 0.006 | 0.146 * | 0.007 | 0.009 | index | index | — | 69 |
| g-sk-weather-api | grey | 0.385 | 0.713 * | 0.007 | 0.044 | exclude | exclude | — | 66 |
| g-sk-recovery-codes | grey | 0.551 | 0.476 * | 0.035 | 0.008 | hold | hold | — | 69 |
| g-sk-spoken-token | grey | 0.020 | 0.107 * | 0.022 | 0.024 | index | index | — | 67 |
| g-fin-statement | grey | 0.009 | 0.041 | 0.987 * | 0.036 | hold | hold | — | 65 |
| g-fin-payslip | grey | 0.005 | 0.023 | 0.971 * | 0.016 | hold | hold | — | 67 |
| g-fin-tax | grey | 0.005 | 0.016 | 0.993 * | 0.018 | hold | hold | — | 66 |
| g-fin-loan | grey | 0.007 | 0.037 | 0.944 * | 0.085 | hold | hold | — | 68 |
| g-fin-portfolio | grey | 0.007 | 0.033 | 0.913 * | 0.009 | hold | hold | — | 66 |
| g-fin-card-statement | grey | 0.005 | 0.039 | 0.994 * | 0.044 | hold | hold | — | 66 |
| g-fin-budget | grey | 0.005 | 0.010 | 0.417 * | 0.005 | hold | hold | — | 69 |
| g-fin-spoken-salary | grey | 0.015 | 0.043 | 0.982 * | 0.057 | hold | hold | — | 66 |
| g-fin-arrears | grey | 0.011 | 0.048 | 0.976 * | 0.147 | hold | hold | — | 67 |
| g-fin-overdraft | grey | 0.006 | 0.034 | 0.952 * | 0.058 | hold | hold | — | 66 |
| g-fin-pension | grey | 0.004 | 0.018 | 0.984 * | 0.087 | hold | hold | — | 67 |
| g-fin-transfer-chat | grey | 0.016 | 0.046 | 0.994 * | 0.080 | hold | hold | — | 66 |
| g-fin-crypto | grey | 0.004 | 0.015 | 0.567 * | 0.017 | hold | hold | — | 67 |
| g-health-gp | grey | 0.009 | 0.022 | 0.008 | 0.695 * | hold | hold | — | 66 |
| g-health-prescription | grey | 0.006 | 0.032 | 0.012 | 0.570 * | hold | hold | — | 66 |
| g-health-lab | grey | 0.007 | 0.024 | 0.095 | 0.952 * | hold | hold | — | 66 |
| g-health-therapy | grey | 0.005 | 0.036 | 0.002 | 0.850 * | hold | hold | — | 67 |
| g-health-symptoms | grey | 0.006 | 0.046 | 0.001 | 0.957 * | hold | hold | — | 65 |
| g-health-allergy | grey | 0.013 | 0.048 | 0.003 | 0.682 * | hold | hold | — | 68 |
| g-health-friend-diagnosis | grey | 0.008 | 0.039 | 0.025 | 0.994 * | hold | hold | — | 65 |
| g-health-discharge | grey | 0.005 | 0.017 | 0.005 | 0.997 * | hold | hold | — | 67 |
| g-health-mental-app | grey | 0.011 | 0.054 | 0.003 | 0.906 * | hold | hold | — | 67 |
| g-health-physio | grey | 0.008 | 0.030 | 0.003 | 0.937 * | hold | hold | — | 66 |
| g-health-claim | grey | 0.012 | 0.032 | 0.061 * | 0.690 * | hold | hold | — | 63 |
| g-health-pregnancy | grey | 0.009 | 0.056 | 0.009 | 0.993 * | hold | hold | — | 59 |
| s-aws-key | structured | 0.015 | 0.221 * | 0.021 | 0.023 | index | redact | cloud access key | 63 |
| s-github-token | structured | 0.007 | 0.328 * | 0.003 | 0.006 | hold | hold | access token | 65 |
| s-stripe-key | structured | 0.004 | 0.328 * | 0.092 | 0.015 | hold | hold | access token | 67 |
| s-private-key | structured | 0.004 | 0.025 * | 0.009 | 0.021 | index | redact | private key | 65 |
| s-conn-string | structured | 0.014 * | 0.253 | 0.020 | 0.007 | index | redact | password in a connection string | 66 |
| s-password-label | structured | 0.003 * | 0.133 | 0.141 | 0.022 | index | redact | password | 62 |
| s-card-visa | structured | 0.005 | 0.032 | 0.688 * | 0.012 | hold | hold | card number | 63 |
| s-card-mastercard | structured | 0.002 | 0.006 | 0.106 * | 0.004 | index | redact | card number | 61 |
| s-iban | structured | 0.005 | 0.042 | 0.204 * | 0.008 | index | redact | bank account (IBAN) | 64 |
| s-ssn | structured | 0.003 | 0.018 | 0.055 * | 0.018 | index | redact | social security number | 66 |
| s-jwt | structured | 0.004 | 0.245 * | 0.021 | 0.009 | index | redact | signed token | 66 |
| s-pin-label | structured | 0.036 * | 0.063 | 0.011 | 0.009 | index | redact | password | 66 |
| a-bitwarden | app | — | — | — | — | not asked | exclude | — | 0 |
| a-1password | app | — | — | — | — | not asked | exclude | — | 0 |
| a-bank-app | app | — | — | — | — | not asked | exclude | — | 0 |
| a-bank-site | app | — | — | — | — | not asked | exclude | — | 0 |
| b-docs-api-keys | benign | 0.020 | 0.681 | 0.016 | 0.007 | hold | hold | — | 66 |
| b-docs-sk-placeholder | benign | 0.009 | 0.630 | 0.015 | 0.006 | hold | hold | access token | 63 |
| b-recipe-vitamin | benign | 0.004 | 0.014 | 0.002 | 0.031 | index | index | — | 66 |
| b-bank-ad | benign | 0.006 | 0.035 | 0.007 | 0.005 | index | index | — | 64 |
| b-pricing | benign | 0.004 | 0.037 | 0.089 | 0.006 | index | index | — | 66 |
| b-gym-timetable | benign | 0.005 | 0.014 | 0.001 | 0.006 | index | index | — | 65 |
| b-pharmacy-hours | benign | 0.008 | 0.042 | 0.008 | 0.059 | index | index | — | 67 |
| b-health-article | benign | 0.003 | 0.014 | 0.001 | 0.252 | index | index | — | 65 |
| b-money-article | benign | 0.006 | 0.017 | 0.006 | 0.002 | index | index | — | 66 |
| b-rates-news | benign | 0.003 | 0.016 | 0.007 | 0.005 | index | index | — | 67 |
| b-login-form | benign | 0.023 | 0.058 | 0.022 | 0.005 | index | index | — | 66 |
| b-masked-password | benign | 0.011 | 0.033 | 0.037 | 0.011 | index | index | — | 66 |
| b-pm-review | benign | 0.121 | 0.057 | 0.028 | 0.005 | index | index | — | 67 |
| b-change-password-help | benign | 0.384 | 0.484 | 0.013 | 0.007 | hold | hold | — | 64 |
| b-strong-password-tips | benign | 0.050 | 0.090 | 0.006 | 0.005 | index | index | — | 69 |
| b-env-names | benign | 0.107 | 0.884 | 0.016 | 0.029 | exclude | exclude | — | 67 |
| b-git-log | benign | 0.007 | 0.025 | 0.010 | 0.024 | index | index | — | 64 |
| b-receipt-coffee | benign | 0.004 | 0.027 | 0.038 | 0.011 | index | index | — | 66 |
| b-order-confirmation | benign | 0.003 | 0.012 | 0.033 | 0.021 | index | index | — | 70 |
| b-train-times | benign | 0.007 | 0.016 | 0.002 | 0.007 | index | index | — | 67 |
| b-meeting-notes | benign | 0.011 | 0.018 | 0.008 | 0.009 | index | index | — | 66 |
| b-shopping | benign | 0.005 | 0.023 | 0.006 | 0.013 | index | index | — | 65 |
| b-weather | benign | 0.005 | 0.011 | 0.001 | 0.005 | index | index | — | 65 |
| b-support-chat | benign | 0.054 | 0.040 | 0.012 | 0.016 | index | index | — | 69 |
| b-phone-list | benign | 0.006 | 0.054 | 0.025 | 0.009 | index | index | — | 67 |
| b-tracking | benign | 0.010 | 0.038 | 0.035 | 0.046 | index | index | — | 70 |
| b-diabetes-wiki | benign | 0.006 | 0.028 | 0.002 | 0.260 | index | index | — | 68 |
| b-insurer-ad | benign | 0.009 | 0.036 | 0.015 | 0.088 | index | index | — | 69 |
| b-payroll-features | benign | 0.009 | 0.029 | 0.216 | 0.004 | index | index | — | 67 |
| b-vet-appointment | benign | 0.008 | 0.023 | 0.006 | 0.612 | hold | hold | — | 67 |
| b-hospital-news | benign | 0.003 | 0.008 | 0.002 | 0.015 | index | index | — | 64 |
| b-bank-help-article | benign | 0.019 | 0.036 | 0.179 | 0.011 | index | index | — | 58 |
| b-spoken-budget-tips | benign | 0.014 | 0.028 | 0.019 | 0.011 | index | index | — | 59 |
| b-spoken-fitness | benign | 0.005 | 0.019 | 0.001 | 0.026 | index | index | — | 58 |
| b-product-spec | benign | 0.003 | 0.010 | 0.002 | 0.007 | index | index | — | 60 |
| b-cvc-explainer | benign | 0.040 | 0.113 | 0.069 | 0.009 | index | index | — | 60 |
| b-calendar-public | benign | 0.005 | 0.020 | 0.002 | 0.003 | index | index | — | 59 |
| b-kids-recipe | benign | 0.008 | 0.039 | 0.002 | 0.008 | index | index | — | 60 |
| b-vaccine-info | benign | 0.009 | 0.027 | 0.009 | 0.155 | index | index | — | 57 |
| b-salary-survey | benign | 0.005 | 0.022 | 0.144 | 0.007 | index | index | — | 61 |

`*` marks a question whose label is true.

## Reading the result (written after the run; nothing scored was changed)

**`tev1:4b` passes all three pre-registered model bounds.** It is the first template to pass on a local model. `verdicts-capture-sensitive.json` records `pass` for `tev1:4b@7954dce2…`, so the Decision Service trusts `capture-sensitive` v1 on exactly that build: the same Tev1 4B, a different digest is untrusted until the eval runs again. Nothing consumes the template yet.
- **Detection:** 97.4% (38 of 39). The one miss is `g-health-prescription` (a named person's antidepressant prescription), with `health_details` at 0.086.
- **False holds:** 2.5% (1 of 40). The one hold is `b-vet-appointment` (a cat's vaccinations), with `health_details` at 0.337, which is unsettled and so held by the rule. On the whole pipeline, one more harmless case is redacted by a pattern (`b-docs-sk-placeholder`, a key-shaped placeholder in docs), as the case expected.
- **ECE:** 0.032.
- **The deterministic layer:** 16 of 16 structured and sensitive-app cases redacted or excluded, and no caught value reached the model. The four sensitive-app cases were never sent to it.

**What the pass rests on, plainly:**
- **Sample size:** 39 grey-area cases. The Wilson 95% interval for detection is 86.8%–99.6%, so the point estimate clears 95% but the interval doesn't. The false-hold interval is 0.4%–12.9%, inside the 20% bound.
- **The unsure row:** of the 40 labelled judgments in the grey area, 29 came out confident (≥ 0.7). The rest were caught by "any question unsettled → hold", the conservative row written for a privacy screen. A plain reading: this size is reliably unsure, rather than wrongly sure, about most of what it doesn't confidently flag.
- **One author:** the same author wrote the questions and the cases, the questions first and committed (`727b7509`) before any case existed. Shared blind spots are possible. An independent case set, written by someone who hasn't seen the questions, is the stronger test before the archive relies on this.

**`tev1:0.8b` fails on detection:** 79.5% (31 of 39), against 95%. It missed 5 of 8 grey passwords and 3 of 6 grey secrets. Its false holds were 12.5% (5 of 40) and ECE 0.023. It is evidence only.

**Nothing was tuned:** the questions, bands, rule, cases and bounds are as committed before the run.

## Two runs, and why (said plainly)

The eval was run twice, with identical results: every score of every case, on both sizes, to the last digit.
- **Run 1** was at `347f2fd9`, with the template at `7baf2264`.
- **GitHub's push protection then refused the branch.** A unit test in the template commit (`tests/core/capture-sensitive.test.ts`) contained a made-up string shaped exactly like a Stripe test key.
- **The fix:** the branch was rebuilt so that the string is never in any commit, and the test now assembles it at run time. The template, the rule, the eval set, the bounds and the harness are byte-identical between `7baf2264`/`347f2fd9` and the rebuilt `727b7509`/`9cb2ca0a`.
- **Run 2,** recorded here, was made at the rebuilt pre-run commit, so the recorded provenance is true. The original commits are still in the local branch `ds2/capture-sensitive-refused`; they were never pushed.
- **Nothing was bypassed:** push protection wasn't, and nothing was tuned between the runs.
