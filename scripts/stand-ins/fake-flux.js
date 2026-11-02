#!/usr/bin/env node
// Committed test-only child; never a real cluster CLI.
import { simulate } from './k3s-simulation.js';
await simulate('flux');
