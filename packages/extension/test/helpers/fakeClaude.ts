#!/usr/bin/env node

/**
 * Fake Claude CLI implementation for E2E and Integration Testing.
 * It simulates the output stream of Anthropic's Claude CLI and returns a predictable usage JSON.
 * Usage: node fakeClaude.ts [args...]
 */

const args = process.argv.slice(2);
const isVerbose = args.includes('--verbose');

console.log('🤖 Fake Claude initialized...');
console.log('Thinking about the problem...');

setTimeout(() => {
  console.log('Executing plan and modifying files.');
  
  // Fake writing a file if requested by mock
  if (args.includes('--fake-produce-success')) {
    console.log('Produced all required artifacts.');
  }

  // End with JSON payload which the system parses for token metrics
  const fakeMetrics = {
    "total_duration_ms": 1250,
    "total_cost_usd": 0.0035,
    "total_tokens_used": 1500,
    "input_tokens": 1000,
    "output_tokens": 500
  };

  console.log('### END OF OUTPUT ###');
  console.log(JSON.stringify(fakeMetrics));

  process.exit(0);
}, 200);
