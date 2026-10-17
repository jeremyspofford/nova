// Shared test setup. Under a loaded CI run (every package's tests at once) a jsdom render can
// take seconds, so the async queries wait up to 5 s instead of 1 s. A real failure still fails;
// it only takes longer to report.
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });
