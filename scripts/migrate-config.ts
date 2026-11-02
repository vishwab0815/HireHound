// Converts config files from the old Portuguese format to the current English one:
//   perfil.json -> profile.json, respostas.json -> answers.json, curriculos.json -> resumes.json,
//   and sites.json in place. Existing target files are left alone unless you pass --force.
//   npm run migrate-config [-- --force]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
const force = process.argv.includes('--force');

type Json = Record<string, unknown>;

const read = (file: string): Json | null => {
  const p = path.join(CONFIG_DIR, file);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as Json : null;
};

const write = (file: string, data: unknown, overwrite = force) => {
  const p = path.join(CONFIG_DIR, file);
  if (existsSync(p) && !overwrite) {
    console.log(`skip    config/${file} already exists (use --force to overwrite)`);
    return;
  }
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote   config/${file}`);
};

function renameKeys(obj: Json, map: Record<string, string>): Json {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [map[k] ?? k, v]));
}

const WORK_MODES: Record<string, string> = { remoto: 'remote', hibrido: 'hybrid', presencial: 'onsite' };
const ENGLISH: Record<string, string> = { nenhum: 'none', basico: 'basic', intermediario: 'intermediate', avancado: 'advanced', fluente: 'fluent' };

function migrateProfile(p: Json): Json {
  const out = renameKeys(p, {
    nome: 'name', telefone: 'phone', curriculo_path: 'resumePath', titulo_profissional: 'title',
    anos_experiencia: 'yearsOfExperience', stack_principal: 'coreStack', resumo_profissional: 'summary',
    pretensao_salarial: 'salaryExpectation', modelo_trabalho: 'workModes', cidade: 'city',
    regra_localizacao: 'locationRule', nivel_ingles: 'englishLevel', blacklist_empresas: 'blockedCompanies',
    blacklist_termos_titulo: 'blockedTitleTerms', disponibilidade: 'availability', palavras_chave_busca: 'searchKeywords',
    experiencias: 'experience', bancos_de_dados: 'databases', metodologias: 'methodologies', informacoes_extras: 'extras',
  });
  if (Array.isArray(out.workModes)) out.workModes = (out.workModes as string[]).map(m => WORK_MODES[m] ?? m);
  if (typeof out.englishLevel === 'string') out.englishLevel = ENGLISH[out.englishLevel] ?? out.englishLevel;
  if (Array.isArray(out.experience)) {
    out.experience = (out.experience as Json[]).map(e => renameKeys(e, { empresa: 'company', cargo: 'role', periodo: 'period', descricao: 'description' }));
  }
  if (out.extras && typeof out.extras === 'object') {
    out.extras = renameKeys(out.extras as Json, { formacao: 'education', idiomas: 'languages', certificacoes: 'certifications', diferencial: 'highlights' });
  }
  return out;
}

function migrateAnswers(a: Json): Json {
  const out = renameKeys(a, {
    _comentario: '_note', pretensao_salarial: 'salaryExpectation', disponibilidade_inicio: 'startDate',
    como_conheceu_empresa: 'howDidYouHear', por_que_trabalhar_aqui: 'whyThisCompany', pontos_fortes: 'strengths',
    pontos_fracos: 'weaknesses', expectativa_carreira: 'careerGoals', trabalho_em_equipe: 'teamwork',
    turno_noturno: 'nightShift', trabalho_fim_de_semana: 'weekendWork', notebook_internet: 'laptopAndInternet',
    _todo_preencher: '_toFill',
  });
  if (out._toFill && typeof out._toFill === 'object') {
    out._toFill = renameKeys(out._toFill as Json, {
      _aviso: '_note', possui_deficiencia: 'hasDisability', aceita_viagem: 'openToTravel',
      possui_veiculo: 'hasVehicle', estado_civil: 'maritalStatus', data_nascimento: 'dateOfBirth',
    });
  }
  return out;
}

function migrateResume(r: Json): Json {
  const out = renameKeys(r, { arquivo: 'file', foco: 'focus', usar_quando: 'useWhen' });
  out.keywords ??= [];
  return out;
}

function migrateSites(s: Json): Json {
  const types: Record<string, string> = { portal_vagas: 'job_board', empresa_direta: 'company_site' };
  return {
    sites: ((s.sites as Json[]) ?? []).map(site => {
      const out = renameKeys(site, { nome: 'name', urls_busca: 'searchUrls', tipo: 'type', instrucoes: 'instructions', ativo: 'enabled' });
      if (typeof out.type === 'string') out.type = types[out.type] ?? out.type;
      return out;
    }),
  };
}

const profile = read('perfil.json');
if (profile) write('profile.json', migrateProfile(profile));

const answers = read('respostas.json');
if (answers) write('answers.json', migrateAnswers(answers));

const resumes = read('curriculos.json');
if (resumes) {
  write('resumes.json', {
    fallback: migrateResume(resumes.fallback as Json),
    resumes: ((resumes.curriculos as Json[]) ?? []).map(migrateResume),
  });
}

const sites = read('sites.json');
if (sites && Array.isArray(sites.sites) && (sites.sites as Json[]).some(s => 'nome' in s)) {
  write('sites.json', migrateSites(sites), true);
}

if (!profile && !answers && !resumes) console.log('Nothing to migrate: no perfil.json, respostas.json or curriculos.json found.');
