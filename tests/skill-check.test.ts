import { describe, it, expect } from 'vitest';
import { findFabricatedSkills, stripCodeFences } from '../src/llm/skill-check';

describe('findFabricatedSkills', () => {
  it('flags technologies the candidate does not have', () => {
    const made = findFabricatedSkills('I have solid experience with Python and Django.', ['Java', 'Spring']);
    expect(made).toContain('python');
    expect(made).toContain('django');
  });

  it('accepts technologies the candidate lists', () => {
    expect(findFabricatedSkills('I use Angular and React every day.', ['Angular', 'React'])).toEqual([]);
  });

  it('matches in both directions ("Spring Boot" covers "spring boot")', () => {
    expect(findFabricatedSkills('Production experience with Spring Boot.', ['Spring Boot'])).toEqual([]);
  });

  it('accepts a technology backed by the profile text even if it is not a listed skill', () => {
    const text = 'Built machine learning pipelines in production.';
    expect(findFabricatedSkills(text, ['Python'])).toContain('machine learning');
    expect(findFabricatedSkills(text, ['Python'], 'Engineered a multi-disease machine learning system')).toEqual([]);
  });

  it('returns nothing for text without watched technologies', () => {
    expect(findFabricatedSkills('I am a dedicated, collaborative engineer.', ['Java'])).toEqual([]);
  });
});

describe('stripCodeFences', () => {
  it('removes a fence with a language', () => {
    expect(stripCodeFences('```html\n<p>Hi</p>\n```')).toBe('<p>Hi</p>');
  });

  it('removes a bare fence', () => {
    expect(stripCodeFences('```\nplain text\n```')).toBe('plain text');
  });

  it('only trims text without fences', () => {
    expect(stripCodeFences('  just text  ')).toBe('just text');
  });
});
