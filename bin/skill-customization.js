#!/usr/bin/env node
import { main } from "../dist/src/cli.js";

process.exitCode = await main();
