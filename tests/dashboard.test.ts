import { describe, it, expect } from 'vitest';
import { escapeHtml, safeUrl } from '../src/dashboard/server';

describe('escapeHtml', () => {
  it('escapes HTML from untrusted job pages', () => {
    const safe = escapeHtml('<img src=x onerror="alert(1)">');
    expect(safe).not.toContain('<img');
    expect(safe).toContain('&lt;img');
    expect(safe).toContain('&quot;');
  });

  it('handles null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('safeUrl', () => {
  it('keeps http and https links', () => {
    expect(safeUrl('https://internshala.com/job/detail/1')).toContain('https://internshala.com/job/detail/1');
    expect(safeUrl('http://example.com')).toContain('http://example.com');
  });

  it('turns javascript: and other schemes into #', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('data:text/html,<script>')).toBe('#');
    expect(safeUrl('')).toBe('#');
  });
});
