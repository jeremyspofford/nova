# Evidence: memory-gate and its eval

Written by `tests/acceptance/memory-gate-eval-real.test.ts` (opt-in, `NOVA_REAL_MEMORY_GATE=1`); plan `docs/plans/ds2-memory-gate.md`. Per-case results: `docs/evidence/memory-gate-eval.json`. Verdicts the Decision Service follows: `src/core/decision-service/verdicts-memory-gate.json`, recomputed in CI. All conversations are synthetic.

- **The template, its rule and the bounds, fixed before any eval case:** commit `7d5871687db36e24982d01c2631f8dd0d4f5c52f`.
- **The eval, fixed before any run:** commit `6392c6b0af076a325c1d1417ed0fdd0bb42d79de`.
- **The set:** 75 cases; expected outcomes save 26, skip 30, merge 11, flag 8. SHA-256 `9edd6f696a1e9a76b2c02654cef0a8ebdb055e8f2c30cc4bbf5a864fe269a160`.
- **Bounds:** false saves ≤ 5%; save recall ≥ 75%; ECE ≤ 0.10 (10 bins). A wrongly saved memory is worse than a missed one.

## Verdicts

| Size | Verdict | Trusted? | False saves | Save recall | ECE | Flag recall | Merge recall | Accuracy | Digest | Run |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| tev1:4b | pass (all three bounds met) | yes | 0% (0/49) | 96.2% (25/26) | 0.082 | 62.5% (5/8) | 100% (11/11) | 94.7% (71/75) | 7954dce22bc6c29c3b119656207681d12cb34434fed7caa086bfbc919bef0740 | 2026-11-01T03:33:44.691Z |
| tev1:0.8b | fail (save recall 0% is below 75%; ECE 0.111 is above 0.10) | no: evidence only | 0% (0/49) | 0% (0/26) | 0.111 | 25% (2/8) | 54.5% (6/11) | 50.7% (38/75) | abc31fdb0bf52506cc47091145ac19c4cfb509b73a6841789324f9e32200c099 | 2026-11-01T03:34:01.798Z |

## The set by category

| Category | Cases |
| --- | ---: |
| lasting fact | 12 |
| standing preference | 8 |
| passing remark | 7 |
| today’s plans | 2 |
| one-off request | 8 |
| only in Nova’s answer | 8 |
| more than the person said | 5 |
| duplicate | 8 |
| contradiction | 8 |
| related but different | 6 |
| exact duplicate | 3 |

## tev1:4b

- False saves: 0% (0/49), Wilson 95% 0–0.0727. Saved wrongly: none.
- Save recall: 96.2% (25/26), Wilson 95% 0.8111–0.9932. Missed: fact-partner.
- ECE 0.082; by question: lasting 0.171, in_person_words 0.062, duplicate 0.071, contradicts 0.109.
- Deterministic (exact duplicates, no model call): 100% (3/3). Unanswered: none.

### Reliability bins

| Bin | Pairs | Mean p | Share true |
| --- | ---: | ---: | ---: |
| [0.0, 0.1) | 105 | 0.043 | 0.000 |
| [0.1, 0.2) | 21 | 0.144 | 0.000 |
| [0.2, 0.3) | 18 | 0.242 | 0.000 |
| [0.3, 0.4) | 8 | 0.332 | 0.000 |
| [0.4, 0.5) | 6 | 0.441 | 0.000 |
| [0.5, 0.6) | 3 | 0.535 | 0.000 |
| [0.6, 0.7) | 5 | 0.663 | 0.600 |
| [0.7, 0.8) | 3 | 0.742 | 0.333 |
| [0.8, 0.9) | 10 | 0.857 | 0.700 |
| [0.9, 1.0] | 109 | 0.967 | 0.982 |

### Per case

| Case | Category | lasting | in_person_words | duplicate | contradicts | Expected | Outcome | ms |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| fact-moved | lasting fact | 0.991 * | 0.991 * | 0.049 | 0.183 | save | save | 382 |
| fact-job | lasting fact | 0.968 * | 0.983 * | 0.043 | 0.048 | save | save | 178 |
| fact-sister | lasting fact | 0.992 * | 0.991 * | 0.026 | 0.022 | save | save | 178 |
| fact-dog | lasting fact | 0.936 * | 0.963 * | 0.080 | 0.067 | save | save | 171 |
| fact-language | lasting fact | 0.972 * | 0.934 * | 0.052 | 0.048 | save | save | 162 |
| fact-car | lasting fact | 0.972 * | 0.992 * | 0.052 | 0.089 | save | save | 162 |
| fact-partner | lasting fact | 0.914 * | 0.991 * | 0.041 | 0.919 | save | flag | 163 |
| fact-choir | lasting fact | 0.970 * | 0.986 * | 0.018 | 0.064 | save | save | 170 |
| fact-allotment | lasting fact | 0.969 * | 0.984 * | 0.022 | 0.053 | save | save | 163 |
| fact-kids | lasting fact | 0.964 * | 0.959 * | 0.067 | 0.064 | save | save | 177 |
| fact-birthday | lasting fact | 0.989 * | 0.987 * | 0.021 | 0.016 | save | save | 173 |
| fact-flat-floor | lasting fact | 0.991 * | 0.972 * | 0.026 | 0.045 | save | save | 174 |
| pref-vegetarian | standing preference | 0.985 * | 0.979 * | 0.062 | 0.034 | save | save | 168 |
| pref-train | standing preference | 0.996 * | 0.991 * | 0.048 | 0.046 | save | save | 172 |
| pref-mornings | standing preference | 0.941 * | 0.981 * | 0.089 | 0.057 | save | save | 649 |
| pref-metric | standing preference | 0.960 * | 0.976 * | 0.095 | 0.018 | save | save | 620 |
| pref-short | standing preference | 0.963 * | 0.988 * | 0.101 | 0.025 | save | save | 593 |
| pref-aisle | standing preference | 0.986 * | 0.987 * | 0.024 | 0.030 | save | save | 359 |
| pref-tea | standing preference | 0.971 * | 0.988 * | 0.048 | 0.030 | save | save | 409 |
| pref-email | standing preference | 0.973 * | 0.979 * | 0.024 | 0.024 | save | save | 387 |
| pass-tired | passing remark | 0.129 | 0.992 * | 0.050 | 0.038 | skip | skip | 388 |
| pass-rain | passing remark | 0.280 | 0.982 * | 0.042 | 0.043 | skip | skip | 175 |
| pass-lunch | passing remark | 0.423 | 0.986 * | 0.032 | 0.051 | skip | skip | 171 |
| pass-cinema | today’s plans | 0.266 | 0.976 * | 0.021 | 0.050 | skip | skip | 172 |
| pass-mood | passing remark | 0.111 | 0.985 * | 0.051 | 0.020 | skip | skip | 173 |
| pass-traffic | passing remark | 0.131 | 0.941 * | 0.017 | 0.037 | skip | skip | 178 |
| pass-phone | passing remark | 0.346 | 0.988 * | 0.020 | 0.135 | skip | skip | 182 |
| pass-weekend | today’s plans | 0.461 | 0.983 * | 0.026 | 0.036 | skip | skip | 179 |
| pass-hungry | passing remark | 0.172 | 0.995 * | 0.028 | 0.011 | skip | skip | 171 |
| once-table | one-off request | 0.188 | 0.981 * | 0.025 | 0.070 | skip | skip | 177 |
| once-timer | one-off request | 0.405 | 0.937 * | 0.024 | 0.033 | skip | skip | 169 |
| once-gift | one-off request | 0.744 | 0.992 * | 0.017 | 0.028 | skip | skip | 194 |
| once-train | one-off request | 0.213 | 0.982 * | 0.030 | 0.014 | skip | skip | 187 |
| once-recipe | one-off request | 0.097 | 0.971 * | 0.027 | 0.022 | skip | skip | 177 |
| once-translate | one-off request | 0.324 | 0.959 * | 0.068 | 0.009 | skip | skip | 181 |
| once-remind | one-off request | 0.269 | 0.748 * | 0.011 | 0.201 | skip | skip | 183 |
| once-weather | one-off request | 0.315 | 0.931 * | 0.021 | 0.033 | skip | skip | 178 |
| nova-cheese | only in Nova’s answer | 0.566 | 0.180 | 0.091 | 0.034 | skip | skip | 186 |
| nova-sister-name | only in Nova’s answer | 0.888 | 0.302 | 0.011 | 0.031 | skip | skip | 185 |
| nova-city | only in Nova’s answer | 0.271 | 0.302 | 0.018 | 0.078 | skip | skip | 175 |
| nova-job-guess | only in Nova’s answer | 0.840 | 0.665 | 0.076 | 0.682 | skip | skip | 180 |
| nova-diet | only in Nova’s answer | 0.267 | 0.122 | 0.020 | 0.055 | skip | skip | 177 |
| nova-kids-age | only in Nova’s answer | 0.396 | 0.072 | 0.016 | 0.033 | skip | skip | 161 |
| nova-hobby | only in Nova’s answer | 0.534 | 0.042 | 0.027 | 0.054 | skip | skip | 159 |
| nova-pet | only in Nova’s answer | 0.254 | 0.111 | 0.047 | 0.303 | skip | skip | 165 |
| over-brother | more than the person said | 0.831 * | 0.123 | 0.017 | 0.444 | skip | skip | 175 |
| over-yoga | more than the person said | 0.203 | 0.047 | 0.010 | 0.367 | skip | skip | 163 |
| over-city | more than the person said | 0.235 | 0.504 | 0.026 | 0.442 | skip | skip | 168 |
| over-spanish | more than the person said | 0.186 | 0.055 | 0.039 | 0.471 | skip | skip | 171 |
| over-boss | more than the person said | 0.900 | 0.732 | 0.076 | 0.904 | skip | skip | 178 |
| dup-pepper | duplicate | 0.982 * | 0.961 * | 0.939 * | 0.030 | merge | merge | 182 |
| dup-librarian | duplicate | 0.993 * | 0.984 * | 0.940 * | 0.208 | merge | merge | 175 |
| dup-veg | duplicate | 0.988 * | 0.987 * | 0.819 * | 0.165 | merge | merge | 176 |
| dup-train | duplicate | 0.987 * | 0.985 * | 0.961 * | 0.069 | merge | merge | 186 |
| dup-celsius | duplicate | 0.980 * | 0.957 * | 0.880 * | 0.105 | merge | merge | 178 |
| dup-sister | duplicate | 0.970 * | 0.937 * | 0.904 * | 0.059 | merge | merge | 181 |
| dup-choir | duplicate | 0.976 * | 0.976 * | 0.805 * | 0.053 | merge | merge | 175 |
| dup-tea | duplicate | 0.984 * | 0.966 * | 0.893 * | 0.123 | merge | merge | 179 |
| con-moved | contradiction | 0.916 * | 0.828 * | 0.072 | 0.964 * | flag | flag | 634 |
| con-job | contradiction | 0.979 * | 0.979 * | 0.163 | 0.984 * | flag | flag | 577 |
| con-meat | contradiction | 0.662 * | 0.971 * | 0.155 | 0.964 * | flag | skip | 611 |
| con-fly | contradiction | 0.923 * | 0.925 * | 0.127 | 0.947 * | flag | flag | 397 |
| con-coffee | contradiction | 0.955 * | 0.981 * | 0.083 | 0.957 * | flag | flag | 394 |
| con-car | contradiction | 0.955 * | 0.982 * | 0.230 | 0.968 * | flag | flag | 405 |
| con-choir | contradiction | 0.642 * | 0.934 * | 0.195 | 0.932 * | flag | skip | 371 |
| con-sister-city | contradiction | 0.932 * | 0.668 * | 0.220 | 0.958 * | flag | skip | 174 |
| rel-brother | related but different | 0.938 * | 0.959 * | 0.085 | 0.059 | save | save | 162 |
| rel-second-cat | related but different | 0.945 * | 0.926 * | 0.280 | 0.126 | save | save | 161 |
| rel-partner-job | related but different | 0.945 * | 0.883 * | 0.277 | 0.211 | save | save | 157 |
| rel-allergy-free | related but different | 0.981 * | 0.987 * | 0.069 | 0.057 | save | save | 157 |
| rel-second-home | related but different | 0.972 * | 0.958 * | 0.091 | 0.243 | save | save | 170 |
| rel-cousin | related but different | 0.957 * | 0.966 * | 0.226 | 0.066 | save | save | 181 |
| exact-pepper | exact duplicate | — | — | — | — | merge | merge (no model call) | 0 |
| exact-celsius | exact duplicate | — | — | — | — | merge | merge (no model call) | 0 |
| exact-train | exact duplicate | — | — | — | — | merge | merge (no model call) | 0 |

`*` marks a question whose label is true.

## tev1:0.8b

- False saves: 0% (0/49), Wilson 95% 0–0.0727. Saved wrongly: none.
- Save recall: 0% (0/26), Wilson 95% 0–0.1287. Missed: fact-moved, fact-job, fact-sister, fact-dog, fact-language, fact-car, fact-partner, fact-choir, fact-allotment, fact-kids, fact-birthday, fact-flat-floor, pref-vegetarian, pref-train, pref-mornings, pref-metric, pref-short, pref-aisle, pref-tea, pref-email, rel-brother, rel-second-cat, rel-partner-job, rel-allergy-free, rel-second-home, rel-cousin.
- ECE 0.111; by question: lasting 0.133, in_person_words 0.152, duplicate 0.352, contradicts 0.194.
- Deterministic (exact duplicates, no model call): 100% (3/3). Unanswered: none.

### Reliability bins

| Bin | Pairs | Mean p | Share true |
| --- | ---: | ---: | ---: |
| [0.0, 0.1) | 12 | 0.085 | 0.000 |
| [0.1, 0.2) | 51 | 0.157 | 0.000 |
| [0.2, 0.3) | 40 | 0.245 | 0.025 |
| [0.3, 0.4) | 22 | 0.348 | 0.182 |
| [0.4, 0.5) | 26 | 0.448 | 0.269 |
| [0.5, 0.6) | 22 | 0.552 | 0.500 |
| [0.6, 0.7) | 29 | 0.656 | 0.655 |
| [0.7, 0.8) | 30 | 0.749 | 0.800 |
| [0.8, 0.9) | 37 | 0.840 | 0.892 |
| [0.9, 1.0] | 19 | 0.940 | 1.000 |

### Per case

| Case | Category | lasting | in_person_words | duplicate | contradicts | Expected | Outcome | ms |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| fact-moved | lasting fact | 0.919 * | 0.719 * | 0.425 | 0.287 | save | skip | 6477 |
| fact-job | lasting fact | 0.736 * | 0.748 * | 0.507 | 0.227 | save | skip | 230 |
| fact-sister | lasting fact | 0.966 * | 0.827 * | 0.533 | 0.169 | save | merge | 219 |
| fact-dog | lasting fact | 0.279 * | 0.746 * | 0.254 | 0.178 | save | skip | 233 |
| fact-language | lasting fact | 0.706 * | 0.625 * | 0.125 | 0.190 | save | skip | 206 |
| fact-car | lasting fact | 0.757 * | 0.814 * | 0.452 | 0.254 | save | skip | 249 |
| fact-partner | lasting fact | 0.920 * | 0.799 * | 0.246 | 0.198 | save | skip | 237 |
| fact-choir | lasting fact | 0.874 * | 0.866 * | 0.376 | 0.099 | save | merge | 197 |
| fact-allotment | lasting fact | 0.852 * | 0.739 * | 0.472 | 0.160 | save | skip | 229 |
| fact-kids | lasting fact | 0.559 * | 0.724 * | 0.231 | 0.222 | save | skip | 160 |
| fact-birthday | lasting fact | 0.422 * | 0.828 * | 0.844 | 0.096 | save | skip | 227 |
| fact-flat-floor | lasting fact | 0.904 * | 0.805 * | 0.717 | 0.196 | save | merge | 155 |
| pref-vegetarian | standing preference | 0.816 * | 0.674 * | 0.479 | 0.289 | save | skip | 86 |
| pref-train | standing preference | 0.976 * | 0.838 * | 0.344 | 0.117 | save | merge | 87 |
| pref-mornings | standing preference | 0.784 * | 0.816 * | 0.673 | 0.187 | save | skip | 86 |
| pref-metric | standing preference | 0.840 * | 0.676 * | 0.554 | 0.142 | save | skip | 83 |
| pref-short | standing preference | 0.821 * | 0.906 * | 0.761 | 0.087 | save | merge | 87 |
| pref-aisle | standing preference | 0.933 * | 0.831 * | 0.528 | 0.175 | save | merge | 85 |
| pref-tea | standing preference | 0.849 * | 0.734 * | 0.670 | 0.214 | save | skip | 84 |
| pref-email | standing preference | 0.816 * | 0.821 * | 0.477 | 0.143 | save | merge | 88 |
| pass-tired | passing remark | 0.259 | 0.761 * | 0.284 | 0.137 | skip | skip | 99 |
| pass-rain | passing remark | 0.042 | 0.303 * | 0.131 | 0.250 | skip | skip | 95 |
| pass-lunch | passing remark | 0.119 | 0.692 * | 0.465 | 0.146 | skip | skip | 105 |
| pass-cinema | today’s plans | 0.184 | 0.702 * | 0.170 | 0.231 | skip | skip | 102 |
| pass-mood | passing remark | 0.318 | 0.782 * | 0.526 | 0.091 | skip | skip | 103 |
| pass-traffic | passing remark | 0.096 | 0.797 * | 0.232 | 0.172 | skip | skip | 96 |
| pass-phone | passing remark | 0.163 | 0.643 * | 0.231 | 0.152 | skip | skip | 86 |
| pass-weekend | today’s plans | 0.262 | 0.524 * | 0.099 | 0.175 | skip | skip | 86 |
| pass-hungry | passing remark | 0.148 | 0.592 * | 0.263 | 0.168 | skip | skip | 97 |
| once-table | one-off request | 0.403 | 0.801 * | 0.455 | 0.248 | skip | skip | 92 |
| once-timer | one-off request | 0.347 | 0.674 * | 0.248 | 0.216 | skip | skip | 91 |
| once-gift | one-off request | 0.426 | 0.850 * | 0.706 | 0.098 | skip | skip | 92 |
| once-train | one-off request | 0.082 | 0.499 * | 0.139 | 0.318 | skip | skip | 84 |
| once-recipe | one-off request | 0.256 | 0.651 * | 0.463 | 0.146 | skip | skip | 81 |
| once-translate | one-off request | 0.199 | 0.628 * | 0.253 | 0.128 | skip | skip | 82 |
| once-remind | one-off request | 0.206 | 0.576 * | 0.217 | 0.310 | skip | skip | 94 |
| once-weather | one-off request | 0.107 | 0.491 * | 0.085 | 0.299 | skip | skip | 88 |
| nova-cheese | only in Nova’s answer | 0.386 | 0.555 | 0.363 | 0.123 | skip | skip | 90 |
| nova-sister-name | only in Nova’s answer | 0.526 | 0.734 | 0.761 | 0.181 | skip | skip | 90 |
| nova-city | only in Nova’s answer | 0.404 | 0.604 | 0.202 | 0.186 | skip | skip | 96 |
| nova-job-guess | only in Nova’s answer | 0.077 | 0.364 | 0.105 | 0.178 | skip | skip | 94 |
| nova-diet | only in Nova’s answer | 0.171 | 0.455 | 0.253 | 0.207 | skip | skip | 93 |
| nova-kids-age | only in Nova’s answer | 0.583 | 0.620 | 0.622 | 0.186 | skip | skip | 79 |
| nova-hobby | only in Nova’s answer | 0.645 | 0.578 | 0.450 | 0.214 | skip | skip | 86 |
| nova-pet | only in Nova’s answer | 0.227 | 0.366 | 0.297 | 0.155 | skip | skip | 88 |
| over-brother | more than the person said | 0.413 * | 0.442 | 0.129 | 0.188 | skip | skip | 94 |
| over-yoga | more than the person said | 0.182 | 0.400 | 0.117 | 0.181 | skip | skip | 89 |
| over-city | more than the person said | 0.686 | 0.615 | 0.408 | 0.273 | skip | skip | 86 |
| over-spanish | more than the person said | 0.115 | 0.389 | 0.072 | 0.166 | skip | skip | 84 |
| over-boss | more than the person said | 0.318 | 0.462 | 0.124 | 0.193 | skip | skip | 87 |
| dup-pepper | duplicate | 0.321 * | 0.575 * | 0.652 * | 0.228 | merge | skip | 94 |
| dup-librarian | duplicate | 0.945 * | 0.643 * | 0.784 * | 0.150 | merge | skip | 96 |
| dup-veg | duplicate | 0.965 * | 0.609 * | 0.604 * | 0.212 | merge | skip | 97 |
| dup-train | duplicate | 0.968 * | 0.868 * | 0.974 * | 0.275 | merge | merge | 100 |
| dup-celsius | duplicate | 0.974 * | 0.844 * | 0.900 * | 0.179 | merge | merge | 93 |
| dup-sister | duplicate | 0.879 * | 0.714 * | 0.695 * | 0.278 | merge | skip | 83 |
| dup-choir | duplicate | 0.860 * | 0.749 * | 0.895 * | 0.138 | merge | skip | 85 |
| dup-tea | duplicate | 0.956 * | 0.869 * | 0.987 * | 0.210 | merge | merge | 84 |
| con-moved | contradiction | 0.865 * | 0.685 * | 0.355 | 0.348 * | flag | skip | 92 |
| con-job | contradiction | 0.921 * | 0.835 * | 0.813 | 0.554 * | flag | flag | 93 |
| con-meat | contradiction | 0.753 * | 0.703 * | 0.394 | 0.501 * | flag | skip | 88 |
| con-fly | contradiction | 0.597 * | 0.660 * | 0.409 | 0.471 * | flag | skip | 84 |
| con-coffee | contradiction | 0.825 * | 0.843 * | 0.818 | 0.546 * | flag | flag | 83 |
| con-car | contradiction | 0.572 * | 0.691 * | 0.327 | 0.313 * | flag | skip | 91 |
| con-choir | contradiction | 0.805 * | 0.740 * | 0.381 | 0.615 * | flag | skip | 93 |
| con-sister-city | contradiction | 0.776 * | 0.475 * | 0.434 | 0.485 * | flag | skip | 100 |
| rel-brother | related but different | 0.919 * | 0.676 * | 0.549 | 0.397 | save | skip | 96 |
| rel-second-cat | related but different | 0.564 * | 0.863 * | 0.773 | 0.208 | save | skip | 103 |
| rel-partner-job | related but different | 0.906 * | 0.797 * | 0.846 | 0.267 | save | skip | 94 |
| rel-allergy-free | related but different | 0.833 * | 0.699 * | 0.549 | 0.329 | save | skip | 84 |
| rel-second-home | related but different | 0.753 * | 0.876 * | 0.700 | 0.110 | save | skip | 82 |
| rel-cousin | related but different | 0.913 * | 0.825 * | 0.700 | 0.171 | save | merge | 80 |
| exact-pepper | exact duplicate | — | — | — | — | merge | merge (no model call) | 0 |
| exact-celsius | exact duplicate | — | — | — | — | merge | merge (no model call) | 0 |
| exact-train | exact duplicate | — | — | — | — | merge | merge (no model call) | 0 |

`*` marks a question whose label is true.

## Reading the result (written after the run; nothing scored was changed)

**`tev1:4b` passes all three pre-registered bounds,** so the Decision Service trusts `memory-gate` v1 on exactly `tev1:4b@7954dce2…`. Nothing consumes it yet.
- **False saves:** 0 of 49. The Wilson 95% interval is 0–7.3%, so the 5% bound is met on the point estimate but not across the whole interval.
- **Save recall:** 25 of 26 (96%).
- **ECE:** 0.082. By question, `lasting` is the least calibrated at 0.171.
- **Information:** exact duplicates merged with no model call (3 of 3); merges 11 of 11; overall accuracy 71 of 75.

**Where it went wrong, plainly:**
- **Three contradictions were skipped instead of flagged:** `con-meat`, `con-choir` and `con-sister-city`. Each had `contradicts` confidently yes (0.93–0.96). But `lasting` (0.64, 0.66) or `in_person_words` (0.67) fell short of the 0.8 a save requires, and the committed rule checks those first. The consequence: the new fact isn't saved, **and the outdated memory stays as it was**.
  - This is a property of the rule as pre-registered, not a model fault.
  - A rule that flags any confident contradiction, whatever the other answers, would be a v2 question, with its own fresh eval. It isn't changed here.
- **One save was flagged as a contradiction:** `fact-partner`. The model read "my partner Sam works night shifts at the hospital" as conflicting with the memory "Works as a librarian" (`contradicts` 0.92). That confuses the partner's job with the person's. It is a model error, and its effect is safe: the person is asked.

**`tev1:0.8b` fails:** it saved nothing (save recall 0 of 26), with ECE 0.111. It never saved wrongly either (0 of 49), but a gate that never saves is useless. It is evidence only.

**One author:** the same author wrote the questions, rule and bounds (committed first, `7d587168`) and the cases (`6392c6b0`). As with capture-sensitive, a case set from someone who hasn't seen the questions would be the stronger test.

**Nothing was tuned.** The questions, bands, rule, cases and bounds are as committed before the run.
