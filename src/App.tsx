import { useState, useMemo, useCallback, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

// ═══════════════════════════════════════════════════════════════════════════════
// POLISH PAYROLL ENGINE 2026 — EMBEDDED
// ═══════════════════════════════════════════════════════════════════════════════
const PL = {
  EE_EMERYTALNA: 0.0976, EE_RENTOWA: 0.015, EE_CHOROBOWA: 0.0245,
  ER_EMERYTALNA: 0.0976, ER_RENTOWA: 0.065, ER_WYPADKOWA: 0.0067, ER_FP: 0.0245, ER_FGSP: 0.001,
  ZDROWOTNA: 0.09,
  PIT_RATE_1: 0.12, PIT_RATE_2: 0.32, PIT_BRACKET_LIMIT: 120000,
  KWOTA_ZMN: 300, KUP_STANDARD: 250, KUP_COMMUTER: 300, KUP_ZLECENIE_RATE: 0.20,
  KUP_50_LIMIT: 120000, ZUS_LIMIT: 282600, ULGA_MLODYCH_LIMIT: 85528,
  PPK_EE_BASIC: 0.02, PPK_ER_BASIC: 0.015,
  VAT_RATES: { 23: 0.23, 8: 0.08, 5: 0.05, 0: 0 },
  B2B_ZUS_FULL_BASE: 5652.00, B2B_ZUS_PREF_BASE: 1441.80,
  B2B_ZUS_RATES_SUM: 0.0976 * 2 + 0.015 + 0.065 + 0.0245 + 0.0167 + 0.0245, // ~0.3409 total social
  B2B_LINIOWY: 0.19, B2B_ZDROWOTNA_LINIOWY: 0.049, B2B_ZDROWOTNA_SKALA: 0.09,
  B2B_RYCZALT_RATES: { 3: 0.03, 5.5: 0.055, 8.5: 0.085, 10: 0.10, 12: 0.12, 14: 0.14, 15: 0.15, 17: 0.17 },
  B2B_ZDROWOTNA_RYCZALT: [498.35, 830.58, 1495.04],
  B2B_RYCZALT_THRESHOLDS: [60000, 300000],
  B2B_DEFAULT_KSIEGOWOSC: 500,
  B2B_ZUS_WYPADKOWA: 0.0167,         // B2B standardowa wypadkowa (do 9 osób) — nie zależy od stawki firmy-zleceniodawcy
  B2B_ZDROWOTNA_MIN_STY: 314.96,    // min. zdrowotna styczeń 2026 (75% × 4666 × 9%, rok składkowy lut 2025–sty 2026)
  B2B_ZDROWOTNA_MIN_LUT_GRU: 432.54, // min. zdrowotna luty–grudzień 2026 (4806 × 9%)
  B2B_ZDROWOTNA_DEDUCTION_LINIOWY_ANNUAL_LIMIT: 11600,
  B2B_ZDROWOTNA_DEDUCTION_RYCZALT_RATE: 0.50,
  // ========== Sick Leave (L4) ==========
  L4_EMPLOYER_DAYS_STANDARD: 33,
  L4_EMPLOYER_DAYS_OVER50: 14,
  L4_RATE_STANDARD: 0.80,
  L4_RATE_PREGNANCY: 1.00,
  L4_RATE_ACCIDENT: 1.00,
  L4_WORKING_DAYS_PER_MONTH: 21,
  // ========== Maternity / Parental Leave ==========
  MACIERZYNSKI_RATE: 1.00,
  RODZICIELSKI_RATE_FULL: 0.70,
  RODZICIELSKI_RATE_COMBINED: 0.815,
  OJCOWSKI_RATE: 1.00,
  // ========== Derived ==========
  get ER_FULL() { return this.ER_EMERYTALNA + this.ER_RENTOWA + this.ER_WYPADKOWA + this.ER_FP + this.ER_FGSP; },
  get ER_REDUCED() { return this.ER_WYPADKOWA + this.ER_FP + this.ER_FGSP; },
  get ER_LIMITED() { return this.ER_EMERYTALNA + this.ER_RENTOWA; },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT ALIASES — mapowanie alternatywnych nazw umów na typy bazowe
// ═══════════════════════════════════════════════════════════════════════════════
const CONTRACT_ALIASES = [
  { id: 'kontrakt_b2b', label: 'Kontrakt menedżerski (B2B)', short: 'K.Men.', mapsTo: 'b2b', color: '#059669', desc: 'B2B z fakturą — kontrakt na DG' },
  { id: 'kontrakt_zlec', label: 'Kontrakt menedżerski (zlec.)', short: 'K.Zlec.', mapsTo: 'zlecenie_full', color: '#7c3aed', desc: 'Jak zlecenie — pełne składki' },
  { id: 'agencyjna', label: 'Umowa agencyjna', short: 'Agent.', mapsTo: 'zlecenie_full', color: '#7c3aed', desc: 'Jak zlecenie — pełne składki' },
  { id: 'zlecenie_student', label: 'Zlecenie student <26', short: 'Zlec.Stud.', mapsTo: 'zlecenie_full', color: '#a855f7', desc: 'Brak ZUS/PIT — netto = brutto', forceOpts: { student26: true } },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SICK LEAVE (L4) CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Automatyczne obliczanie L4 z liczby dni chorobowych.
 * Dzieli dni na: pracodawca (pierwsze 33/14 dni) vs ZUS (po przekroczeniu limitu).
 * Zwraca podział brutto na: przepracowane + chorobowe pracodawcy + zasiłek ZUS.
 */
function calcSickLeave(monthlyBrutto, sickDays, cumSickDaysYear = 0, opts = {}) {
  const over50 = opts.over50 ?? false;
  const reason = opts.reason ?? 'standard';
  const workDays = opts.workingDaysInMonth ?? PL.L4_WORKING_DAYS_PER_MONTH;

  const employerDaysLimit = over50 ? PL.L4_EMPLOYER_DAYS_OVER50 : PL.L4_EMPLOYER_DAYS_STANDARD;
  const sickRate = reason === 'pregnancy' ? PL.L4_RATE_PREGNANCY
    : reason === 'accident' ? PL.L4_RATE_ACCIDENT
    : PL.L4_RATE_STANDARD;

  // Podstawa chorobowego = brutto - składki społeczne pracownika (z 12 mies., uproszczenie: bieżące)
  const socialEERate = PL.EE_EMERYTALNA + PL.EE_RENTOWA + PL.EE_CHOROBOWA;
  const sickDailyBase = (monthlyBrutto - monthlyBrutto * socialEERate) / 30; // prawo: dzielnik 30
  const sickDailyPay = +(sickDailyBase * sickRate).toFixed(2);

  // Podział dni: pracodawca vs ZUS
  const employerDaysRemaining = Math.max(0, employerDaysLimit - cumSickDaysYear);
  const employerSickDays = Math.min(sickDays, employerDaysRemaining);
  const zusSickDays = Math.max(0, sickDays - employerSickDays);

  // Przepracowane dni
  const workedDays = Math.max(0, workDays - sickDays);

  // Kwoty
  const workedBrutto = +(monthlyBrutto / workDays * workedDays).toFixed(2);
  const employerSickPay = +(sickDailyPay * employerSickDays).toFixed(2);
  const zusSickPay = +(sickDailyPay * zusSickDays).toFixed(2);
  const totalBrutto = +(workedBrutto + employerSickPay + zusSickPay).toFixed(2);

  return {
    workedDays, sickDays: +sickDays,
    employerSickDays, zusSickDays,
    workedBrutto, employerSickPay, zusSickPay,
    totalBrutto,
    cumSickDaysAfter: cumSickDaysYear + sickDays,
    sickDailyPay, sickRate,
  };
}

/**
 * Urlop macierzyński/rodzicielski/ojcowski.
 * ZUS wypłaca świadczenie, koszt pracodawcy = 0.
 */
function calcMaternityLeave(monthlyBrutto, leaveType = 'macierzynski', daysInMonth = 21, workingDaysInMonth = 21) {
  const rates = {
    macierzynski: PL.MACIERZYNSKI_RATE,
    rodzicielski: PL.RODZICIELSKI_RATE_FULL,
    rodzicielski_combined: PL.RODZICIELSKI_RATE_COMBINED,
    ojcowski: PL.OJCOWSKI_RATE,
  };
  const rate = rates[leaveType] ?? PL.MACIERZYNSKI_RATE;
  const proportion = Math.min(1, daysInMonth / workingDaysInMonth);
  const zusBenefit = +(monthlyBrutto * rate * proportion).toFixed(2);

  return {
    leaveType, rate, zusBenefit,
    employerCost: 0, brutto: 0, netto: 0,
    socEE: 0, zusER: 0, health: 0, pit: 0, ppkEE: 0, ppkER: 0,
    totalCost: 0,
    isLeave: true, leaveDays: daysInMonth,
  };
}

function _rawPIT(taxBase, cumIncome, kwotaZmn) {
  const nc = cumIncome + taxBase;
  let pit;
  if (cumIncome >= PL.PIT_BRACKET_LIMIT) pit = taxBase * PL.PIT_RATE_2 - kwotaZmn;
  else if (nc > PL.PIT_BRACKET_LIMIT) {
    const i1 = PL.PIT_BRACKET_LIMIT - cumIncome;
    pit = i1 * PL.PIT_RATE_1 + (taxBase - i1) * PL.PIT_RATE_2 - kwotaZmn;
  } else pit = taxBase * PL.PIT_RATE_1 - kwotaZmn;
  return Math.max(0, Math.round(pit));
}

// Wrapper: handles ulga dla młodych with granular threshold crossing
function computePIT(taxBase, cumIncome, kwotaZmn, under26 = false, cumIncomeForUlga = 0, przychod = 0) {
  const newCumIncome = cumIncome + taxBase;
  const newCumIncomeForUlga = cumIncomeForUlga + przychod;

  if (under26) {
    if (cumIncomeForUlga >= PL.ULGA_MLODYCH_LIMIT) {
      // Already exceeded limit — full PIT applies
    } else if (newCumIncomeForUlga <= PL.ULGA_MLODYCH_LIMIT) {
      // Fully within limit — no PIT
      return { pit: 0, newCumIncome, newCumIncomeForUlga };
    } else {
      // Crossing the limit this month — partial exemption
      const exemptPart = PL.ULGA_MLODYCH_LIMIT - cumIncomeForUlga;
      const taxablePart = przychod - exemptPart;
      const adjustedTaxBase = Math.max(0, Math.round(taxBase * (taxablePart / przychod)));
      const pit = _rawPIT(adjustedTaxBase, cumIncome, kwotaZmn);
      return { pit, newCumIncome, newCumIncomeForUlga };
    }
  }

  const pit = _rawPIT(taxBase, cumIncome, kwotaZmn);
  return { pit, newCumIncome, newCumIncomeForUlga };
}

function calcUoP(employerCost, cumBrutto = 0, cumIncome = 0, opts = {}) {
  const kup = opts.kup ?? PL.KUP_STANDARD;
  const ppkEE = opts.ppkEE ?? 0;
  const ppkER = opts.ppkER ?? 0;
  const kwotaZmn = opts.kwotaZmniejszajaca ?? PL.KWOTA_ZMN;
  const remote = opts.remoteAllowance ?? 0;
  const benefitPIT = opts.benefitPITOnly ?? 0;   // benefit wpływa TYLKO na PIT (np. MultiSport pracodawca)
  const potracenie = opts.potracenieNetto ?? 0;   // potrącenie z netto (np. MultiSport pracownik)

  const cost = Math.max(0, Math.abs(employerCost) - remote);
  const limR = Math.max(0, PL.ZUS_LIMIT - cumBrutto);
  const erF = PL.ER_FULL + ppkER;
  const erR = PL.ER_REDUCED + ppkER;

  let brutto;
  const bf = cost / (1 + erF);
  if (bf <= limR) brutto = bf;
  else if (limR <= 0) brutto = cost / (1 + erR);
  else brutto = (cost - limR * PL.ER_LIMITED) / (1 + erR);

  // ZUS i zdrowotna naliczane od samego brutto (benefit NIE wchodzi do bazy ZUS/zdrowotnej)
  const bu = Math.min(brutto, limR);

  const ee_em = +(bu * PL.EE_EMERYTALNA).toFixed(2);
  const ee_re = +(bu * PL.EE_RENTOWA).toFixed(2);
  const ee_ch = +(brutto * PL.EE_CHOROBOWA).toFixed(2);
  const socEE = +(ee_em + ee_re + ee_ch).toFixed(2);

  const ppkEEAmt = brutto * ppkEE;
  const ppkERAmt = brutto * ppkER;

  const hBase = Math.max(0, brutto - socEE);
  const health = +(hBase * PL.ZDROWOTNA).toFixed(2);

  // PIT: benefit PIT-only zwiększa podstawę opodatkowania
  const under26 = opts.under26 ?? false;
  const cumIncomeForUlga = opts.cumIncomeForUlga ?? 0;
  const taxBase = Math.max(0, Math.round(brutto + benefitPIT - socEE - kup));
  const pitResult = computePIT(taxBase, cumIncome, kwotaZmn, under26, cumIncomeForUlga, brutto);
  const netto = +(brutto - socEE - health - pitResult.pit - ppkEEAmt - potracenie).toFixed(2);

  const er_em = +(bu * PL.ER_EMERYTALNA).toFixed(2);
  const er_re = +(bu * PL.ER_RENTOWA).toFixed(2);
  const er_wy = +(brutto * PL.ER_WYPADKOWA).toFixed(2);
  const er_fp = +(brutto * PL.ER_FP).toFixed(2);
  const er_fg = +(brutto * PL.ER_FGSP).toFixed(2);
  const zusER = +(er_em + er_re + er_wy + er_fp + er_fg).toFixed(2);
  const totalCost = +(brutto + zusER + ppkERAmt + benefitPIT + remote).toFixed(2);

  return {
    brutto: +brutto.toFixed(2), netto, pit: pitResult.pit, health: +health.toFixed(2),
    socEE: +socEE.toFixed(2), zusER: +zusER.toFixed(2), ppkEE: +ppkEEAmt.toFixed(2), ppkER: +ppkERAmt.toFixed(2),
    totalCost, remote, benefitPIT, potracenie,
    cumBruttoAfter: +(cumBrutto + brutto).toFixed(2),
    cumIncomeAfter: +pitResult.newCumIncome.toFixed(2),
    cumIncomeForUlgaAfter: +pitResult.newCumIncomeForUlga.toFixed(2),
  };
}

function calcUoPFromBrutto(brutto, cumBrutto = 0, cumIncome = 0, opts = {}) {
  const kup = opts.kup ?? PL.KUP_STANDARD;
  const ppkEE = opts.ppkEE ?? 0;
  const ppkER = opts.ppkER ?? 0;
  const kwotaZmn = opts.kwotaZmniejszajaca ?? PL.KWOTA_ZMN;
  const remote = opts.remoteAllowance ?? 0;
  const benefitPIT = opts.benefitPITOnly ?? 0;
  const potracenie = opts.potracenieNetto ?? 0;
  const sickPay = opts.sickPay ?? 0;
  const zasilekZUS = opts.zasilekZUS ?? 0;       // zasiłek chorobowy/macierzyński (ZUS pays) — exempt from ZUS, health, KUP

  const b = Math.abs(brutto);
  const zasilek = Math.min(zasilekZUS, b);
  const nonZasilek = b - zasilek;                 // portion subject to normal rules (work + wynagrodzenie chorobowe)
  const workB = Math.max(0, nonZasilek - sickPay); // work portion only (for social ZUS)
  const limR = Math.max(0, PL.ZUS_LIMIT - cumBrutto);

  // Social ZUS only on work portion (sick pay exempt, zasiłek exempt)
  const wu = Math.min(workB, limR);
  const ee_em = +(wu * PL.EE_EMERYTALNA).toFixed(2);
  const ee_re = +(wu * PL.EE_RENTOWA).toFixed(2);
  const ee_ch = +(workB * PL.EE_CHOROBOWA).toFixed(2);
  const socEE = +(ee_em + ee_re + ee_ch).toFixed(2);

  const ppkEEAmt = +(workB * ppkEE).toFixed(2);
  const ppkERAmt = +(workB * ppkER).toFixed(2);

  // Health: only on non-zasiłek portion (work + chorobowe), NOT on zasiłek ZUS
  const hBase = Math.max(0, nonZasilek - socEE);
  const health = +(hBase * PL.ZDROWOTNA).toFixed(2);

  // PIT: KUP applies only if there's non-zasiłek income; zasiłek has no KUP
  const under26 = opts.under26 ?? false;
  const cumIncomeForUlga = opts.cumIncomeForUlga ?? 0;
  const kupApplicable = nonZasilek > 0 ? kup : 0;
  const taxBase = Math.max(0, Math.round(b + benefitPIT - socEE - kupApplicable));
  const pitResult = computePIT(taxBase, cumIncome, kwotaZmn, under26, cumIncomeForUlga, b);
  const netto = +(b - socEE - health - pitResult.pit - ppkEEAmt - potracenie).toFixed(2);

  // Employer ZUS only on work portion
  const bu = Math.min(workB, limR);
  const er_em = +(bu * PL.ER_EMERYTALNA).toFixed(2);
  const er_re = +(bu * PL.ER_RENTOWA).toFixed(2);
  const er_wy = +(workB * PL.ER_WYPADKOWA).toFixed(2);
  const er_fp = +(workB * PL.ER_FP).toFixed(2);
  const er_fg = +(workB * PL.ER_FGSP).toFixed(2);
  const zusER = +(er_em + er_re + er_wy + er_fp + er_fg).toFixed(2);
  const totalCost = +(b + zusER + ppkERAmt + benefitPIT + remote).toFixed(2);

  return {
    brutto: b, netto, pit: pitResult.pit, health: +health.toFixed(2),
    socEE, zusER, ppkEE: ppkEEAmt, ppkER: ppkERAmt,
    totalCost, remote, benefitPIT, potracenie, sickPay, zasilekZUS: zasilek,
    cumBruttoAfter: +(cumBrutto + b).toFixed(2),
    cumIncomeAfter: +pitResult.newCumIncome.toFixed(2),
    cumIncomeForUlgaAfter: +pitResult.newCumIncomeForUlga.toFixed(2),
  };
}

function calcZlecenieFull(employerCost, cumBrutto = 0, cumIncome = 0, opts = {}) {
  const withCh = opts.chorobowa ?? false;
  const ppkEE = opts.ppkEE ?? 0;
  const ppkER = opts.ppkER ?? 0;
  const kwotaZmn = opts.kwotaZmniejszajaca ?? PL.KWOTA_ZMN;
  const useKup50 = opts.kup50 ?? false;
  const cumKUP50 = opts.cumKUP50 ?? 0;

  const cost = Math.abs(employerCost);
  const limR = Math.max(0, PL.ZUS_LIMIT - cumBrutto);
  const erF = PL.ER_FULL + ppkER;
  const erR = PL.ER_REDUCED + ppkER;

  let brutto;
  const bf = cost / (1 + erF);
  if (bf <= limR) brutto = bf;
  else if (limR <= 0) brutto = cost / (1 + erR);
  else brutto = (cost - limR * PL.ER_LIMITED) / (1 + erR);

  const bu = Math.min(brutto, limR);
  const ee_em = +(bu * PL.EE_EMERYTALNA).toFixed(2);
  const ee_re = +(bu * PL.EE_RENTOWA).toFixed(2);
  const ee_ch = withCh ? +(brutto * PL.EE_CHOROBOWA).toFixed(2) : 0;
  const socEE = +(ee_em + ee_re + ee_ch).toFixed(2);

  const ppkEEAmt = brutto * ppkEE;
  const ppkERAmt = brutto * ppkER;

  const hBase = Math.max(0, brutto - socEE);
  const health = +(hBase * PL.ZDROWOTNA).toFixed(2);

  let kup, kupUsed = 0;
  if (useKup50) {
    const avail = Math.max(0, PL.KUP_50_LIMIT - cumKUP50);
    kup = Math.min((brutto - socEE) * 0.5, avail);
    kupUsed = kup;
  } else {
    kup = (brutto - socEE) * PL.KUP_ZLECENIE_RATE;
  }

  const under26 = opts.under26 ?? false;
  const cumIncomeForUlga = opts.cumIncomeForUlga ?? 0;
  const taxBase = Math.max(0, Math.round(brutto - socEE - kup));
  const pitResult = computePIT(taxBase, cumIncome, kwotaZmn, under26, cumIncomeForUlga, brutto);
  const netto = brutto - socEE - health - pitResult.pit - ppkEEAmt;

  const er_em = +(bu * PL.ER_EMERYTALNA).toFixed(2);
  const er_re = +(bu * PL.ER_RENTOWA).toFixed(2);
  const er_wy = +(brutto * PL.ER_WYPADKOWA).toFixed(2);
  const er_fp = +(brutto * PL.ER_FP).toFixed(2);
  const er_fg = +(brutto * PL.ER_FGSP).toFixed(2);
  const zusER = +(er_em + er_re + er_wy + er_fp + er_fg).toFixed(2);
  const totalCost = brutto + zusER + ppkERAmt;

  return {
    brutto: +brutto.toFixed(2), netto: +netto.toFixed(2), pit: pitResult.pit, health: +health.toFixed(2),
    socEE: +socEE.toFixed(2), zusER: +zusER.toFixed(2), ppkEE: +ppkEEAmt.toFixed(2), ppkER: +ppkERAmt.toFixed(2),
    totalCost: +totalCost.toFixed(2),
    cumBruttoAfter: +(cumBrutto + brutto).toFixed(2),
    cumIncomeAfter: +pitResult.newCumIncome.toFixed(2),
    cumIncomeForUlgaAfter: +pitResult.newCumIncomeForUlga.toFixed(2),
    cumKUP50After: useKup50 ? cumKUP50 + kupUsed : undefined,
  };
}

function calcZlecenieFromBrutto(brutto, cumBrutto = 0, cumIncome = 0, opts = {}) {
  const withCh = opts.chorobowa ?? false;
  const ppkEE = opts.ppkEE ?? 0;
  const ppkER = opts.ppkER ?? 0;
  const kwotaZmn = opts.kwotaZmniejszajaca ?? PL.KWOTA_ZMN;
  const useKup50 = opts.kup50 ?? false;
  const cumKUP50 = opts.cumKUP50 ?? 0;

  const b = Math.abs(brutto);
  const limR = Math.max(0, PL.ZUS_LIMIT - cumBrutto);
  const bu = Math.min(b, limR);

  const ee_em = +(bu * PL.EE_EMERYTALNA).toFixed(2);
  const ee_re = +(bu * PL.EE_RENTOWA).toFixed(2);
  const ee_ch = withCh ? +(b * PL.EE_CHOROBOWA).toFixed(2) : 0;
  const socEE = +(ee_em + ee_re + ee_ch).toFixed(2);

  const ppkEEAmt = +(b * ppkEE).toFixed(2);
  const ppkERAmt = +(b * ppkER).toFixed(2);

  const hBase = Math.max(0, b - socEE);
  const health = +(hBase * PL.ZDROWOTNA).toFixed(2);

  let kup, kupUsed = 0;
  if (useKup50) {
    const avail = Math.max(0, PL.KUP_50_LIMIT - cumKUP50);
    kup = Math.min((b - socEE) * 0.5, avail);
    kupUsed = kup;
  } else {
    kup = (b - socEE) * PL.KUP_ZLECENIE_RATE;
  }

  const under26 = opts.under26 ?? false;
  const cumIncomeForUlga = opts.cumIncomeForUlga ?? 0;
  const taxBase = Math.max(0, Math.round(b - socEE - kup));
  const pitResult = computePIT(taxBase, cumIncome, kwotaZmn, under26, cumIncomeForUlga, b);
  const netto = +(b - socEE - health - pitResult.pit - ppkEEAmt).toFixed(2);

  const er_em = +(bu * PL.ER_EMERYTALNA).toFixed(2);
  const er_re = +(bu * PL.ER_RENTOWA).toFixed(2);
  const er_wy = +(b * PL.ER_WYPADKOWA).toFixed(2);
  const er_fp = +(b * PL.ER_FP).toFixed(2);
  const er_fg = +(b * PL.ER_FGSP).toFixed(2);
  const zusER = +(er_em + er_re + er_wy + er_fp + er_fg).toFixed(2);
  const totalCost = +(b + zusER + ppkERAmt).toFixed(2);

  return {
    brutto: b, netto, pit: pitResult.pit, health: +health.toFixed(2),
    socEE: +socEE.toFixed(2), zusER: +zusER.toFixed(2), ppkEE: ppkEEAmt, ppkER: ppkERAmt,
    totalCost,
    cumBruttoAfter: +(cumBrutto + b).toFixed(2),
    cumIncomeAfter: +pitResult.newCumIncome.toFixed(2),
    cumIncomeForUlgaAfter: +pitResult.newCumIncomeForUlga.toFixed(2),
    cumKUP50After: useKup50 ? cumKUP50 + kupUsed : undefined,
  };
}

function calcB2B(invoiceNetto, opts = {}) {
  const n = Math.abs(invoiceNetto);
  const vatRate = PL.VAT_RATES[opts.vatRate ?? 23] ?? 0.23;
  const vat = +(n * vatRate).toFixed(2);
  // totalCost = netto faktury (VAT jest odliczalny, nie jest kosztem pracodawcy)
  return {
    brutto: +(n + vat).toFixed(2), netto: n, invoiceNetto: n, vat, vatRate,
    totalCost: n, pit: 0, health: 0, socEE: 0, zusER: 0, ppkEE: 0, ppkER: 0,
    cumBruttoAfter: 0, cumIncomeAfter: 0,
  };
}

function calcB2BNetto(monthlyNetto, opts = {}) {
  const p = Math.abs(monthlyNetto);
  const taxForm = opts.taxForm || 'liniowy';
  const zusBasis = opts.zusBasis ?? 'full';
  const withCh = opts.chorobowa ?? true;
  const ks = opts.ksiegowosc ?? PL.B2B_DEFAULT_KSIEGOWOSC;
  const inne = opts.inneCosts ?? 0;
  const cumIncome = opts.cumIncome ?? 0;
  const cumPrzychod = opts.cumPrzychod ?? 0;
  const cumZdrowotnaDeducted = opts.cumZdrowotnaDeducted ?? 0;
  const monthIndex = opts.monthIndex ?? 1; // 0=sty, 1=lut, ... (domyślnie lut+ dla bezpieczeństwa)

  // ZUS social — ulga_na_start / zbieg / none: brak składek społecznych; pref: obniżona podstawa bez FP
  const noSocial = zusBasis === 'none' || zusBasis === 'zbieg' || zusBasis === 'ulga_na_start';
  let zusBase = zusBasis === 'pref' ? PL.B2B_ZUS_PREF_BASE
    : noSocial ? 0 : PL.B2B_ZUS_FULL_BASE;

  // FP: nie opłacają samozatrudnieni gdy podstawa < minimalna (preferencyjny, mały ZUS plus)
  const paysFP = !noSocial && zusBase >= 4806;
  const zusRatesSum = PL.EE_EMERYTALNA * 2 + PL.EE_RENTOWA + PL.ER_RENTOWA
    + (withCh ? PL.EE_CHOROBOWA : 0) + PL.B2B_ZUS_WYPADKOWA + (paysFP ? PL.ER_FP : 0);
  let zusSoc = noSocial ? 0 : +(zusBase * zusRatesSum).toFixed(2);

  const koszty = zusSoc + ks + inne;
  const dochod = Math.max(0, p - koszty);

  // Zdrowotna — zbieg i ulga_na_start: zdrowotna IS still paid; 'none' = fully exempt
  const minZdrowotna = monthIndex === 0 ? PL.B2B_ZDROWOTNA_MIN_STY : PL.B2B_ZDROWOTNA_MIN_LUT_GRU;
  let zdrowotna;
  if (taxForm === 'ryczalt') {
    // Ryczałt: zdrowotna zależy od rocznego przychodu. Składka jest stała przez cały rok
    // i ustalana na początku roku na podstawie prognozowanego przychodu.
    // Używamy p * 12 jako roczną projekcję (stawka nie zmienia się w ciągu roku).
    const annualPrzychod = p * 12;
    zdrowotna = annualPrzychod <= PL.B2B_RYCZALT_THRESHOLDS[0] ? PL.B2B_ZDROWOTNA_RYCZALT[0]
      : annualPrzychod <= PL.B2B_RYCZALT_THRESHOLDS[1] ? PL.B2B_ZDROWOTNA_RYCZALT[1] : PL.B2B_ZDROWOTNA_RYCZALT[2];
    // Ryczałt ma stałe kwoty — nie podlega minimum z minimalnego wynagrodzenia
  } else if (taxForm === 'liniowy') {
    zdrowotna = Math.max(+(dochod * PL.B2B_ZDROWOTNA_LINIOWY).toFixed(2), minZdrowotna);
  } else {
    zdrowotna = Math.max(+(dochod * PL.B2B_ZDROWOTNA_SKALA).toFixed(2), minZdrowotna);
  }
  if (zusBasis === 'none') zdrowotna = 0; // 'none' = completely exempt; 'zbieg'+'ulga_na_start' still pay

  // Zdrowotna deduction from PIT base
  let zdrowotnaDeducted = 0;
  let adjustedDochod = dochod;
  let adjustedPrzychod = p;

  if (taxForm === 'liniowy') {
    const remainingLimit = Math.max(0, PL.B2B_ZDROWOTNA_DEDUCTION_LINIOWY_ANNUAL_LIMIT - cumZdrowotnaDeducted);
    zdrowotnaDeducted = Math.min(zdrowotna, remainingLimit);
    adjustedDochod = Math.max(0, dochod - zdrowotnaDeducted);
  } else if (taxForm === 'ryczalt') {
    zdrowotnaDeducted = +(zdrowotna * PL.B2B_ZDROWOTNA_DEDUCTION_RYCZALT_RATE).toFixed(2);
    adjustedPrzychod = Math.max(0, p - zdrowotnaDeducted);
  }
  // skala: no deduction

  // PIT
  let pit;
  const rRate = PL.B2B_RYCZALT_RATES[opts.ryczaltRate ?? 12] ?? 0.12;
  if (taxForm === 'liniowy') pit = +(adjustedDochod * PL.B2B_LINIOWY).toFixed(2);
  else if (taxForm === 'ryczalt') pit = +(adjustedPrzychod * rRate).toFixed(2);
  else {
    // Skala podatkowa — progressive brackets
    const newCumIncome = cumIncome + adjustedDochod;
    let pitRaw;
    if (cumIncome >= PL.PIT_BRACKET_LIMIT) {
      pitRaw = adjustedDochod * PL.PIT_RATE_2 - PL.KWOTA_ZMN;
    } else if (newCumIncome > PL.PIT_BRACKET_LIMIT) {
      const inFirst = PL.PIT_BRACKET_LIMIT - cumIncome;
      pitRaw = inFirst * PL.PIT_RATE_1 + (adjustedDochod - inFirst) * PL.PIT_RATE_2 - PL.KWOTA_ZMN;
    } else {
      pitRaw = adjustedDochod * PL.PIT_RATE_1 - PL.KWOTA_ZMN;
    }
    pit = +(Math.max(0, pitRaw)).toFixed(2);
  }

  const total = zusSoc + zdrowotna + pit + ks + inne;
  const effectiveRate = p > 0 ? +((total / p) * 100).toFixed(1) : 0;

  return {
    przychod: p, zusSoc, zdrowotna, zdrowotnaDeducted: +zdrowotnaDeducted.toFixed(2),
    pit, ksiegowosc: ks, totalDeductions: +total.toFixed(2), nettoNaReke: +(p - total).toFixed(2),
    effectiveRate,
    cumIncomeAfter: +(cumIncome + (taxForm === 'skala' ? adjustedDochod : dochod)).toFixed(2),
    cumPrzychodAfter: +(cumPrzychod + p).toFixed(2),
    cumZdrowotnaDeductedAfter: +(cumZdrowotnaDeducted + zdrowotnaDeducted).toFixed(2),
  };
}

function calcDzielo50(employerCost, cumKUP50 = 0, cumBrutto = 0, opts = {}) {
  const sameEmployer = opts.sameEmployer ?? false;

  if (!sameEmployer) {
    // Standardowe dzieło — brak ZUS, brak zdrowotnej
    const b = Math.abs(employerCost);
    const avail = Math.max(0, PL.KUP_50_LIMIT - cumKUP50);
    const kup = Math.min(b * 0.5, avail);
    const tb = Math.max(0, Math.round(b - kup));
    const pit = Math.max(0, Math.round(tb * PL.PIT_RATE_1));
    return {
      brutto: b, netto: +(b - pit).toFixed(2), totalCost: b,
      pit, health: 0, socEE: 0, zusER: 0, ppkEE: 0, ppkER: 0,
      cumKUP50After: cumKUP50 + kup, cumBruttoAfter: 0, cumIncomeAfter: 0,
    };
  }

  // Dzieło u tego samego pracodawcy — obowiązkowy ZUS jak UoP
  const cost = Math.abs(employerCost);
  const limR = Math.max(0, PL.ZUS_LIMIT - cumBrutto);
  const erF = PL.ER_FULL;
  const erR = PL.ER_REDUCED;

  let brutto;
  const bf = cost / (1 + erF);
  if (bf <= limR) brutto = bf;
  else if (limR <= 0) brutto = cost / (1 + erR);
  else brutto = (cost - limR * PL.ER_LIMITED) / (1 + erR);

  const bu = Math.min(brutto, limR);
  const ee_em = +(bu * PL.EE_EMERYTALNA).toFixed(2);
  const ee_re = +(bu * PL.EE_RENTOWA).toFixed(2);
  const ee_ch = +(brutto * PL.EE_CHOROBOWA).toFixed(2);
  const socEE = +(ee_em + ee_re + ee_ch).toFixed(2);

  const hBase = Math.max(0, brutto - socEE);
  const health = +(hBase * PL.ZDROWOTNA).toFixed(2);

  const avail = Math.max(0, PL.KUP_50_LIMIT - cumKUP50);
  const kup = Math.min((brutto - socEE) * 0.5, avail);
  const tb = Math.max(0, Math.round(brutto - socEE - kup));
  const pit = Math.max(0, Math.round(tb * PL.PIT_RATE_1));
  const netto = +(brutto - socEE - health - pit).toFixed(2);

  const er_em = +(bu * PL.ER_EMERYTALNA).toFixed(2);
  const er_re = +(bu * PL.ER_RENTOWA).toFixed(2);
  const er_wy = +(brutto * PL.ER_WYPADKOWA).toFixed(2);
  const er_fp = +(brutto * PL.ER_FP).toFixed(2);
  const er_fg = +(brutto * PL.ER_FGSP).toFixed(2);
  const zusER = +(er_em + er_re + er_wy + er_fp + er_fg).toFixed(2);
  const totalCost = +(brutto + zusER).toFixed(2);

  return {
    brutto: +brutto.toFixed(2), netto, totalCost,
    pit, health, socEE, zusER, ppkEE: 0, ppkER: 0,
    cumKUP50After: cumKUP50 + kup,
    cumBruttoAfter: +(cumBrutto + brutto).toFixed(2),
    cumIncomeAfter: 0,
  };
}

function calcDzielo50FromBrutto(brutto, cumKUP50 = 0, cumBrutto = 0, opts = {}) {
  const sameEmployer = opts.sameEmployer ?? false;

  if (!sameEmployer) {
    // Standardowe dzieło: brak ZUS → totalCost = brutto, identyczna logika
    const b = Math.abs(brutto);
    const avail = Math.max(0, PL.KUP_50_LIMIT - cumKUP50);
    const kup = Math.min(b * 0.5, avail);
    const tb = Math.max(0, Math.round(b - kup));
    const pit = Math.max(0, Math.round(tb * PL.PIT_RATE_1));
    return {
      brutto: b, netto: +(b - pit).toFixed(2), totalCost: b,
      pit, health: 0, socEE: 0, zusER: 0, ppkEE: 0, ppkER: 0,
      cumKUP50After: cumKUP50 + kup, cumBruttoAfter: 0, cumIncomeAfter: 0,
    };
  }

  // Dzieło u tego samego pracodawcy — brutto jest dane, oblicz ZUS/PIT/netto od brutto
  const b = Math.abs(brutto);
  const limR = Math.max(0, PL.ZUS_LIMIT - cumBrutto);
  const bu = Math.min(b, limR);

  const ee_em = +(bu * PL.EE_EMERYTALNA).toFixed(2);
  const ee_re = +(bu * PL.EE_RENTOWA).toFixed(2);
  const ee_ch = +(b * PL.EE_CHOROBOWA).toFixed(2);
  const socEE = +(ee_em + ee_re + ee_ch).toFixed(2);

  const hBase = Math.max(0, b - socEE);
  const health = +(hBase * PL.ZDROWOTNA).toFixed(2);

  const avail = Math.max(0, PL.KUP_50_LIMIT - cumKUP50);
  const kup = Math.min((b - socEE) * 0.5, avail);
  const tb = Math.max(0, Math.round(b - socEE - kup));
  const pit = Math.max(0, Math.round(tb * PL.PIT_RATE_1));
  const netto = +(b - socEE - health - pit).toFixed(2);

  const er_em = +(bu * PL.ER_EMERYTALNA).toFixed(2);
  const er_re = +(bu * PL.ER_RENTOWA).toFixed(2);
  const er_wy = +(b * PL.ER_WYPADKOWA).toFixed(2);
  const er_fp = +(b * PL.ER_FP).toFixed(2);
  const er_fg = +(b * PL.ER_FGSP).toFixed(2);
  const zusER = +(er_em + er_re + er_wy + er_fp + er_fg).toFixed(2);
  const totalCost = +(b + zusER).toFixed(2);

  return {
    brutto: b, netto, totalCost,
    pit, health, socEE, zusER, ppkEE: 0, ppkER: 0,
    cumKUP50After: cumKUP50 + kup,
    cumBruttoAfter: +(cumBrutto + b).toFixed(2),
    cumIncomeAfter: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POWOŁANIE (zarząd/prokurent) — brak ZUS społecznych, tylko zdrowotna 9% + PIT skala
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Wynagrodzenie z tytułu powołania (art. 201 KSH):
 * - BRAK składek społecznych (emerytalna, rentowa, chorobowa) — ani EE ani ER
 * - BRAK FP, FGŚP, wypadkowej
 * - Zdrowotna 9% od brutto — obowiązkowa (od 2022), nieodliczalna
 * - PIT wg skali podatkowej (12%/32%), KUP 250 zł, kwota zmniejszająca jeśli PIT-2
 * - Koszt pracodawcy (spółki) = brutto (brak składek ER)
 * - Brak PPK (brak stosunku pracy)
 */
function calcPowolanie(brutto, cumIncome = 0, opts = {}) {
  const b = Math.abs(brutto);
  const kup = opts.kup ?? PL.KUP_STANDARD; // 250 zł
  const kwotaZmn = opts.kwotaZmniejszajaca ?? 0; // domyślnie 0, chyba że PIT-2
  const under26 = opts.under26 ?? false;
  const cumIncomeForUlga = opts.cumIncomeForUlga ?? 0;

  // Brak składek społecznych
  const socEE = 0;
  const zusER = 0;

  // Zdrowotna 9% od brutto
  const health = +(b * PL.ZDROWOTNA).toFixed(2);

  // PIT: brutto - KUP = podstawa, potem skala
  const taxBase = Math.max(0, Math.round(b - kup));
  const pitResult = computePIT(taxBase, cumIncome, kwotaZmn, under26, cumIncomeForUlga, b);

  const netto = +(b - health - pitResult.pit).toFixed(2);
  const totalCost = b; // brak składek ER — koszt spółki = brutto

  return {
    brutto: b, netto, pit: pitResult.pit, health,
    socEE, zusER, ppkEE: 0, ppkER: 0,
    totalCost,
    cumBruttoAfter: 0, // nie ma ZUS limitu — nie kumuluje brutto
    cumIncomeAfter: +pitResult.newCumIncome.toFixed(2),
    cumIncomeForUlgaAfter: +pitResult.newCumIncomeForUlga.toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const MONTH_LABELS = MONTHS.map((_, i) => new Date(2026, i).toLocaleDateString("pl-PL", { month: "short" }));
const MONTH_LABELS_FULL = MONTHS.map((_, i) => new Date(2026, i).toLocaleDateString("pl-PL", { month: "long" }));

const CONTRACT_TYPES = [
  { id: 'uop', label: 'UoP (umowa o pracę)', short: 'UoP', color: '#3b82f6' },
  { id: 'powolanie', label: 'Powołanie (zarząd)', short: 'Powoł.', color: '#2563eb' },
  { id: 'zlecenie_full', label: 'Umowa zlecenie', short: 'Zlec', color: '#8b5cf6' },
  { id: 'b2b', label: 'B2B (faktura)', short: 'B2B', color: '#10b981' },
  { id: 'dzielo_50kup', label: 'Umowa o dzieło (50% KUP)', short: 'Dzieło', color: '#f59e0b' },
];

const CT_MAP = Object.fromEntries(CONTRACT_TYPES.map(c => [c.id, c]));

const KWOTA_ZMN_OPTIONS = [
  { value: 0, label: 'Zero — płatnik nie jest upoważniony', amount: 0 },
  { value: 1, label: '1 płatnik — 1/12 kwoty zmniejszającej (300 zł)', amount: 300 },
  { value: 2, label: '2 płatników — 1/24 kwoty zmniejszającej (150 zł)', amount: 150 },
  { value: 3, label: '3 płatników — 1/36 kwoty zmniejszającej (100 zł)', amount: 100 },
];

const DEFAULT_OPTS = {
  uop: { kup: 'standard', ppkEE: 0, ppkER: 0, kwotaZmniejszajaca: 0, under26: false, remoteAllowance: 0, benefitPITOnly: 0, potracenieNetto: 0 },
  powolanie: { kup: 'standard', kwotaZmniejszajaca: 0, under26: false },
  zlecenie_full: { chorobowa: false, ppkEE: 0, ppkER: 0, kwotaZmniejszajaca: 0, kup50: false, sameEmployer: false, student26: false },
  b2b: { vatRate: 23, taxForm: 'liniowy', ryczaltRate: 12, zusBasis: 'full', chorobowa: true, ksiegowosc: 500, inneCosts: 0 },
  dzielo_50kup: { sameEmployer: false },
};

let nextId = 1;
let nextCompanyId = 1;

function makeContract(ct = 'uop', aliasId = null) {
  // Jeśli tworzony przez alias, forceOpts nadpisuje domyślne opcje
  const alias = aliasId ? CONTRACT_ALIASES.find(a => a.id === aliasId) : null;
  const baseCt = alias ? alias.mapsTo : ct;
  const baseOpts = JSON.parse(JSON.stringify(DEFAULT_OPTS[baseCt] || {}));
  if (alias?.forceOpts) Object.assign(baseOpts, alias.forceOpts);

  return {
    id: nextId++,
    ct: baseCt,
    aliasId: aliasId || null,  // 'powolanie', 'kontrakt_b2b', etc. — null = standard type
    label: '',
    companyId: null,
    mode: 'fixed',
    inputMode: 'employer',
    fixedAmount: 0,
    // L4 — tryb ręczny (manual) = stare pola; tryb auto = z dni chorobowych
    l4Mode: 'manual',          // 'manual' | 'auto'
    sickPay: 0,                // [manual] wynagrodzenie chorobowe pracodawcy
    zasilekZUS: 0,             // [manual] zasiłek ZUS
    monthlySickPay: Array(12).fill(0),
    monthlyZasilekZUS: Array(12).fill(0),
    l4SickDays: 0,             // [auto, fixed] dni chorobowe/mies.
    monthlyL4SickDays: Array(12).fill(0), // [auto, monthly] dni chorobowe per miesiąc
    l4Over50: false,           // [auto] pracownik 50+ (limit 14 dni pracodawcy)
    l4Reason: 'standard',      // [auto] 'standard' | 'pregnancy' | 'accident'
    // Urlop macierzyński/rodzicielski
    leaveMonths: {},           // { monthIndex: 'macierzynski' | 'rodzicielski' | ... }
    startMonth: 0,
    endMonth: 11,
    monthlyAmounts: Array(12).fill(0),
    opts: baseOpts,
  };
}

function makeCompany(name = '') {
  return {
    id: nextCompanyId++,
    name: name || 'Nowa spółka',
    pkd: '', nip: '',
    wypadkowa: 1.67,    // % — stawka wypadkowa (0.67–3.33), domyślna krajowa
    fep: 0,             // % — Fundusz Emerytur Pomostowych
    fp: 2.45,           // % — Fundusz Pracy
    fgsp: 0.10,         // % — FGŚP
    ppkERBasic: 1.5,    // % — PPK pracodawca bazowa
    ppkERExtra: 0,      // % — PPK pracodawca dodatkowa
    ppkEEBasic: 2.0,    // % — PPK pracownik bazowa
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// YEAR DEFAULTS (parameters that change annually, shared across all companies)
// ═══════════════════════════════════════════════════════════════════════════════
const DEFAULT_YEAR = {
  year: 2026,
  zusLimit: 282600,     // roczny limit 30-krotności
  minWage: 4806,        // minimalne wynagrodzenie brutto 2026
};

const INITIAL_COMPANIES = [
  { ...makeCompany('HugeTech Sp. z o.o.'), wypadkowa: 0.67 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE SHEETS CONNECTION
// Wklej tutaj URL swojego Apps Script po wdrożeniu:
// ═══════════════════════════════════════════════════════════════════════════════
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzqR-CRlW4qS9-kBuq1fe2anBATwqbu6j7gpRh4DJrkUTNgS-yBaRQkERfNvfSru3eenA/exec';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function SalaryPlanner() {
  const [personName, setPersonName] = useState('');
  const [contracts, setContracts] = useState([makeContract('uop')]);
  const [selectedId, setSelectedId] = useState(contracts[0]?.id);
  const [inputMode, setInputMode] = useState('employer');
  const [yearSettings, setYearSettings] = useState({ ...DEFAULT_YEAR });
  const [companies, setCompanies] = useState(INITIAL_COMPANIES);
  const [showYearPanel, setShowYearPanel] = useState(false);
  const [editingCompanyForContract, setEditingCompanyForContract] = useState(null);
  const [hoveredSummaryMonth, setHoveredSummaryMonth] = useState(null);
  const [showInneDropdown, setShowInneDropdown] = useState(false);

  // ── Google Sheets state ─────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('calculator'); // 'calculator' | 'budget'
  const [sheetData, setSheetData] = useState({ people: [], projects: [], budgetLines: [], savedContracts: [] });
  const [sheetsConnected, setSheetsConnected] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null); // { type: 'ok'|'err', text: '...' }
  const [budgetPersons, setBudgetPersons] = useState([]); // przetworzone dane do zakładki Budżet

  const updateYearSettings = useCallback((patch) => {
    setYearSettings(prev => ({ ...prev, ...patch }));
  }, []);

  const updateCompany = useCallback((companyId, patch) => {
    setCompanies(prev => prev.map(c => c.id === companyId ? { ...c, ...patch } : c));
  }, []);

  const addCompany = useCallback((name) => {
    const nc = makeCompany(name);
    setCompanies(prev => [...prev, nc]);
    return nc.id;
  }, []);

  const assignCompany = useCallback((contractId, companyId) => {
    setContracts(prev => prev.map(c => c.id === contractId ? { ...c, companyId } : c));
  }, []);

  const updateContract = useCallback((id, patch) => {
    setContracts(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  }, []);

  const updateOpts = useCallback((id, optPatch) => {
    setContracts(prev => prev.map(c => c.id === id ? { ...c, opts: { ...c.opts, ...optPatch } } : c));
  }, []);

  const addContract = useCallback((ct = 'uop', aliasId = null) => {
    const nc = makeContract(ct, aliasId);
    setContracts(prev => [...prev, nc]);
    setSelectedId(nc.id);
    setShowInneDropdown(false);
  }, []);

  const removeContract = useCallback((id) => {
    setContracts(prev => {
      const next = prev.filter(c => c.id !== id);
      if (next.length === 0) {
        const nc = makeContract('uop');
        setSelectedId(nc.id);
        return [nc];
      }
      if (id === selectedId) setSelectedId(next[0].id);
      return next;
    });
  }, [selectedId]);

  const selected = contracts.find(c => c.id === selectedId);

  // ─── GOOGLE SHEETS: Ładowanie danych przy starcie ─────────────────────
  useEffect(() => {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE') return;
    fetch(`${APPS_SCRIPT_URL}?action=getData`)
      .then(r => r.json())
      .then(data => {
        setSheetData(data);
        setSheetsConnected(true);
        // Przetworz dane budżetu
        if (data.savedContracts && data.savedContracts.length > 0) {
          processBudgetData(data);
        }
      })
      .catch(() => setSheetsConnected(false));
  }, []);

  // ─── GOOGLE SHEETS: Przetwarza zapisane umowy na widok budżetu ────────
  const processBudgetData = useCallback((data) => {
    const { savedContracts = [], people = [], budgetLines = [], projects = [] } = data;
    const peopleMap = {};
    people.forEach(p => { peopleMap[p.person_id] = `${p.first_name} ${p.last_name}`.trim(); });
    const blMap = {};
    budgetLines.forEach(bl => { blMap[bl.budget_line_id] = bl; });
    const projMap = {};
    projects.forEach(p => { projMap[p.project_id] = p; });

    // Grupuj umowy per osoba
    const byPerson = {};
    savedContracts.forEach(c => {
      if (!byPerson[c.person_id]) byPerson[c.person_id] = [];
      byPerson[c.person_id].push(c);
    });

    const persons = Object.entries(byPerson).map(([pid, cts]) => {
      const fullName = peopleMap[pid] || pid;
      const monthly = Array(12).fill(0);
      cts.forEach(c => {
        const start = parseInt(c.start_month) || 1;
        const end   = parseInt(c.end_month) || 12;
        const amt   = parseFloat(c.amount_monthly_pln) || 0;
        for (let m = start; m <= end; m++) monthly[m - 1] += amt;
      });
      const total = monthly.reduce((a, b) => a + b, 0);
      return { pid, fullName, contracts: cts, monthly, total };
    });
    setBudgetPersons(persons);
  }, []);

  // ─── GOOGLE SHEETS: Zapisz bieżącą osobę do budżetu ──────────────────
  const saveToSheets = useCallback(async () => {
    if (!sheetsConnected || !personName.trim()) {
      setSaveMsg({ type: 'err', text: personName.trim() ? 'Brak połączenia z Sheets' : 'Wpisz imię i nazwisko osoby' });
      setTimeout(() => setSaveMsg(null), 3000);
      return;
    }
    setIsSaving(true);
    setSaveMsg(null);
    try {
      const payload = {
        action: 'saveContracts',
        personName: personName.trim(),
        year: yearSettings.year,
        contracts: contracts.map(c => ({
          ct: c.ct,
          label: c.label || c.ct,
          employer: companies.find(co => co.id === c.companyId)?.name || '',
          inputMode: c.inputMode || 'employer',
          amount: c.fixedAmount || 0,
          startMonth: (c.startMonth ?? 0) + 1,
          endMonth:   (c.endMonth ?? 11) + 1,
          budgetLineId: c.budgetLineId || '',
          opts: c.opts || {},
        })),
      };
      await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setSaveMsg({ type: 'ok', text: '✓ Zapisano do budżetu' });
      // Odśwież dane
      const freshData = await fetch(`${APPS_SCRIPT_URL}?action=getData`).then(r => r.json());
      setSheetData(freshData);
      processBudgetData(freshData);
      setTimeout(() => setSaveMsg(null), 3000);
    } catch {
      setSaveMsg({ type: 'err', text: '✗ Błąd zapisu — sprawdź połączenie' });
      setTimeout(() => setSaveMsg(null), 4000);
    }
    setIsSaving(false);
  }, [sheetsConnected, personName, contracts, companies, yearSettings, processBudgetData]);

  // ─── GOOGLE SHEETS: Usuń osobę z budżetu ─────────────────────────────
  const deleteFromBudget = useCallback(async (pName) => {
    if (!sheetsConnected) return;
    try {
      await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ action: 'deletePerson', personName: pName, year: yearSettings.year }),
      });
      const freshData = await fetch(`${APPS_SCRIPT_URL}?action=getData`).then(r => r.json());
      setSheetData(freshData);
      processBudgetData(freshData);
    } catch {}
  }, [sheetsConnected, yearSettings, processBudgetData]);

  // ─── GOOGLE SHEETS: Wczytaj osobę z budżetu do kalkulatora ───────────
  const loadPersonToCalculator = useCallback((person) => {
    setPersonName(person.fullName);
    // Wczytaj pierwszą umowę jako wzorzec (uproszczenie — pełny import w v2)
    setActiveTab('calculator');
  }, []);

  // ─── CALCULATION ENGINE ─────────────────────────────────────────────────
  const results = useMemo(() => {
    // Year-level settings
    PL.ZUS_LIMIT = yearSettings.zusLimit;

    const monthly = contracts.map(c => {
      // Per-contract company rates
      const comp = companies.find(co => co.id === c.companyId) || companies[0] || {};
      PL.ER_WYPADKOWA = (comp.wypadkowa ?? 1.67) / 100;
      PL.ER_FP = (comp.fp ?? 2.45) / 100;
      PL.ER_FGSP = (comp.fgsp ?? 0.10) / 100;
      PL.PPK_EE_BASIC = (comp.ppkEEBasic ?? 2.0) / 100;
      PL.PPK_ER_BASIC = ((comp.ppkERBasic ?? 1.5) + (comp.ppkERExtra ?? 0)) / 100;

      const res = [];
      let cumBrutto = 0, cumIncome = 0, cumKUP50 = 0, cumIncomeForUlga = 0;
      let cumB2BIncome = 0, cumB2BPrzychod = 0, cumB2BZdrowotnaDeducted = 0;
      let cumSickDays = 0; // L4: kumulacja dni chorobowych w roku

      for (let m = 0; m < 12; m++) {
        let amount;
        if (c.mode === 'fixed') {
          amount = (m >= c.startMonth && m <= c.endMonth) ? c.fixedAmount : 0;
        } else {
          amount = c.monthlyAmounts[m] || 0;
        }

        if (!amount || amount <= 0) {
          res.push(null);
          continue;
        }

        let calc;
        const o = c.opts;
        if (c.ct === 'uop') {
          // Sprawdź urlop macierzyński/rodzicielski
          const leaveType = c.leaveMonths?.[m];
          if (leaveType) {
            calc = calcMaternityLeave(amount, leaveType);
            calc.cumBruttoAfter = cumBrutto;
            calc.cumIncomeAfter = cumIncome;
            calc.cumIncomeForUlgaAfter = cumIncomeForUlga;
            res.push(calc);
            continue;
          }

          const kupVal = o.kup === 'commuter' ? PL.KUP_COMMUTER : o.kup === 'none' ? 0 : PL.KUP_STANDARD;
          const kwotaZmn = (KWOTA_ZMN_OPTIONS.find(x => x.value === o.kwotaZmniejszajaca) || KWOTA_ZMN_OPTIONS[0]).amount;

          // L4: auto vs manual
          let sickPayForMonth = 0, zasilekForMonth = 0, l4Info = null;
          if (c.l4Mode === 'auto') {
            const sickDaysForMonth = c.mode === 'monthly' ? (c.monthlyL4SickDays?.[m] || 0) : (c.l4SickDays || 0);
            if (sickDaysForMonth > 0) {
              // W trybie auto, amount to brutto regularne (potrzebne do obliczenia stawki chorobowego)
              const baseBrutto = c.inputMode === 'brutto' ? amount : (() => {
                // Przy employer cost → oblicz przybliżone brutto
                const temp = calcUoP(amount, cumBrutto, cumIncome, { kup: kupVal });
                return temp.brutto;
              })();
              l4Info = calcSickLeave(baseBrutto, sickDaysForMonth, cumSickDays, {
                over50: c.l4Over50, reason: c.l4Reason,
              });
              sickPayForMonth = l4Info.employerSickPay;
              zasilekForMonth = l4Info.zusSickPay;
              cumSickDays = l4Info.cumSickDaysAfter;
              // W trybie auto + brutto: nadpisz kwotę na totalBrutto z L4
              if (c.inputMode === 'brutto') {
                amount = l4Info.totalBrutto;
              }
            }
          } else {
            sickPayForMonth = c.mode === 'monthly' ? (c.monthlySickPay?.[m] || 0) : (c.sickPay || 0);
            zasilekForMonth = c.mode === 'monthly' ? (c.monthlyZasilekZUS?.[m] || 0) : (c.zasilekZUS || 0);
          }

          if (c.inputMode === 'brutto') {
            calc = calcUoPFromBrutto(amount, cumBrutto, cumIncome, {
              kup: kupVal,
              ppkEE: o.ppkEE ? PL.PPK_EE_BASIC : 0,
              ppkER: o.ppkER ? PL.PPK_ER_BASIC : 0,
              kwotaZmniejszajaca: kwotaZmn,
              remoteAllowance: o.remoteAllowance || 0,
              benefitPITOnly: o.benefitPITOnly || 0,
              potracenieNetto: o.potracenieNetto || 0,
              sickPay: sickPayForMonth,
              zasilekZUS: zasilekForMonth,
              under26: o.under26 || false,
              cumIncomeForUlga,
            });
          } else {
            calc = calcUoP(amount, cumBrutto, cumIncome, {
              kup: kupVal,
              ppkEE: o.ppkEE ? PL.PPK_EE_BASIC : 0,
              ppkER: o.ppkER ? PL.PPK_ER_BASIC : 0,
              kwotaZmniejszajaca: kwotaZmn,
              remoteAllowance: o.remoteAllowance || 0,
              benefitPITOnly: o.benefitPITOnly || 0,
              potracenieNetto: o.potracenieNetto || 0,
              under26: o.under26 || false,
              cumIncomeForUlga,
            });
          }
          if (l4Info) calc.l4Info = l4Info; // Dołącz info o L4 do wyniku
          cumBrutto = calc.cumBruttoAfter;
          cumIncome = calc.cumIncomeAfter;
          if (calc.cumIncomeForUlgaAfter !== undefined) cumIncomeForUlga = calc.cumIncomeForUlgaAfter;
        } else if (c.ct === 'powolanie') {
          // Powołanie: brak ZUS społecznych, tylko zdrowotna 9% + PIT skala
          const kupVal = o.kup === 'commuter' ? PL.KUP_COMMUTER : o.kup === 'none' ? 0 : PL.KUP_STANDARD;
          const kwotaZmn = (KWOTA_ZMN_OPTIONS.find(x => x.value === o.kwotaZmniejszajaca) || KWOTA_ZMN_OPTIONS[0]).amount;
          calc = calcPowolanie(amount, cumIncome, {
            kup: kupVal,
            kwotaZmniejszajaca: kwotaZmn,
            under26: o.under26 || false,
            cumIncomeForUlga,
          });
          cumIncome = calc.cumIncomeAfter;
          if (calc.cumIncomeForUlgaAfter !== undefined) cumIncomeForUlga = calc.cumIncomeForUlgaAfter;
        } else if (c.ct === 'zlecenie_full') {
          // Student <26 lat: netto = brutto, brak ZUS/PIT/zdrowotnej
          if (o.student26) {
            const b = Math.abs(amount);
            calc = {
              brutto: b, netto: b, totalCost: b,
              pit: 0, health: 0, socEE: 0, zusER: 0, ppkEE: 0, ppkER: 0,
              cumBruttoAfter: cumBrutto, cumIncomeAfter: cumIncome,
            };
          } else {
            const kwotaZmnZlec = (KWOTA_ZMN_OPTIONS.find(x => x.value === o.kwotaZmniejszajaca) || KWOTA_ZMN_OPTIONS[0]).amount;
            const zlecOpts = {
              chorobowa: o.sameEmployer ? true : o.chorobowa,
              ppkEE: o.ppkEE ? PL.PPK_EE_BASIC : 0,
              ppkER: o.ppkER ? PL.PPK_ER_BASIC : 0,
              kwotaZmniejszajaca: kwotaZmnZlec,
              kup50: o.kup50,
              cumKUP50: cumKUP50,
              under26: o.under26 || false,
              cumIncomeForUlga,
            };
            if (c.inputMode === 'brutto') {
              calc = calcZlecenieFromBrutto(amount, cumBrutto, cumIncome, zlecOpts);
            } else {
              calc = calcZlecenieFull(amount, cumBrutto, cumIncome, zlecOpts);
            }
            cumBrutto = calc.cumBruttoAfter;
            cumIncome = calc.cumIncomeAfter;
            if (calc.cumIncomeForUlgaAfter !== undefined) cumIncomeForUlga = calc.cumIncomeForUlgaAfter;
            if (calc.cumKUP50After !== undefined) cumKUP50 = calc.cumKUP50After;
          }
        } else if (c.ct === 'b2b') {
          calc = calcB2B(amount, { vatRate: o.vatRate ?? 23 });
          // Also compute contractor netto if tax form selected
          if (o.taxForm) {
            calc.contractorNetto = calcB2BNetto(amount, {
              taxForm: o.taxForm, zusBasis: o.zusBasis, chorobowa: o.chorobowa,
              ryczaltRate: o.ryczaltRate, ksiegowosc: o.ksiegowosc, inneCosts: o.inneCosts,
              cumIncome: cumB2BIncome, cumPrzychod: cumB2BPrzychod, cumZdrowotnaDeducted: cumB2BZdrowotnaDeducted,
              monthIndex: m,
            });
            // Track cumulative B2B state
            if (calc.contractorNetto.cumIncomeAfter !== undefined) cumB2BIncome = calc.contractorNetto.cumIncomeAfter;
            if (calc.contractorNetto.cumPrzychodAfter !== undefined) cumB2BPrzychod = calc.contractorNetto.cumPrzychodAfter;
            if (calc.contractorNetto.cumZdrowotnaDeductedAfter !== undefined) cumB2BZdrowotnaDeducted = calc.contractorNetto.cumZdrowotnaDeductedAfter;
          }
        } else if (c.ct === 'dzielo_50kup') {
          if (c.inputMode === 'brutto') {
            calc = calcDzielo50FromBrutto(amount, cumKUP50, cumBrutto, {
              sameEmployer: o.sameEmployer || false,
            });
          } else {
            calc = calcDzielo50(amount, cumKUP50, cumBrutto, {
              sameEmployer: o.sameEmployer || false,
            });
          }
          cumKUP50 = calc.cumKUP50After;
          if (o.sameEmployer) {
            cumBrutto = calc.cumBruttoAfter;
          }
        }
        res.push(calc);
      }
      return res;
    });

    // Aggregate per month
    const totals = MONTHS.map((_, m) => {
      let totalCost = 0, totalNetto = 0, totalPIT = 0, totalZUS_EE = 0, totalZUS_ER = 0, totalHealth = 0, totalBrutto = 0;
      let naReke = 0; // kwota "na rękę" po wszystkich kosztach (w tym B2B ZUS/PIT/księgowość)
      contracts.forEach((c, ci) => {
        const r = monthly[ci][m];
        if (!r) return;
        totalCost += r.totalCost || 0;
        totalNetto += r.netto || 0;
        totalPIT += r.pit || 0;
        totalZUS_EE += r.socEE || 0;
        totalZUS_ER += r.zusER || 0;
        totalHealth += r.health || 0;
        totalBrutto += r.brutto || 0;
        // Na rękę: dla B2B bierz contractorNetto.nettoNaReke (po ZUS/PIT/księgowości),
        // dla pozostałych umów netto = na rękę
        if (c.ct === 'b2b' && r.contractorNetto) {
          naReke += r.contractorNetto.nettoNaReke || 0;
        } else if (c.ct === 'b2b') {
          naReke += r.netto || 0; // fallback jeśli brak kalkulacji kontrahenta
        } else {
          naReke += r.netto || 0;
        }
      });
      return {
        month: MONTH_LABELS[m], monthFull: MONTH_LABELS_FULL[m],
        totalCost: +totalCost.toFixed(2), totalNetto: +totalNetto.toFixed(2),
        totalPIT: +totalPIT.toFixed(2), totalZUS_EE: +totalZUS_EE.toFixed(2),
        totalZUS_ER: +totalZUS_ER.toFixed(2), totalHealth: +totalHealth.toFixed(2),
        totalBrutto: +totalBrutto.toFixed(2), naReke: +naReke.toFixed(2),
      };
    });

    const annual = totals.reduce((acc, t) => ({
      totalCost: acc.totalCost + t.totalCost,
      totalNetto: acc.totalNetto + t.totalNetto,
      totalPIT: acc.totalPIT + t.totalPIT,
      totalZUS_EE: acc.totalZUS_EE + t.totalZUS_EE,
      totalZUS_ER: acc.totalZUS_ER + t.totalZUS_ER,
      totalHealth: acc.totalHealth + t.totalHealth,
      totalBrutto: acc.totalBrutto + t.totalBrutto,
      naReke: acc.naReke + t.naReke,
    }), { totalCost: 0, totalNetto: 0, totalPIT: 0, totalZUS_EE: 0, totalZUS_ER: 0, totalHealth: 0, totalBrutto: 0, naReke: 0 });

    return { monthly, totals, annual };
  }, [contracts, companies, yearSettings]);

  const fmt = (v) => v != null ? v.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł' : '—';
  const fmtShort = (v) => v != null ? (v / 1000).toFixed(1) + 'k' : '—';

  // ─── RENDER ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', fontSize: 13, color: '#1e293b', background: '#f8fafc' }}>
      {/* HEADER */}
      <div style={{ background: '#1e293b', color: 'white', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap' }}>Planer Wynagrodzeń {yearSettings.year}</div>

        {/* Zakładki */}
        <div style={{ display: 'flex', gap: 2, background: '#0f172a', borderRadius: 8, padding: 3 }}>
          {[['calculator','📋 Kalkulator'],['budget','📊 Budżet osobowy']].map(([tab, label]) => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: activeTab === tab ? '#3b82f6' : 'transparent',
              color: activeTab === tab ? 'white' : '#94a3b8',
            }}>{label}{tab === 'budget' && budgetPersons.length > 0 && (
              <span style={{ marginLeft: 6, background: '#10b981', color: 'white', borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{budgetPersons.length}</span>
            )}</button>
          ))}
        </div>

        {/* Pole osoby — combobox */}
        {activeTab === 'calculator' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap' }}>Osoba:</label>
            <div style={{ position: 'relative' }}>
              <input
                value={personName}
                onChange={e => setPersonName(e.target.value)}
                list="people-list"
                placeholder="Imię i nazwisko..."
                style={{ padding: '5px 10px', borderRadius: 6, border: 'none', fontSize: 13, width: 220, background: '#334155', color: 'white' }}
              />
              {sheetData.people.length > 0 && (
                <datalist id="people-list">
                  {sheetData.people.map(p => (
                    <option key={p.person_id} value={`${p.first_name} ${p.last_name}`.trim()} />
                  ))}
                </datalist>
              )}
            </div>
          </div>
        )}

        {/* Przycisk Zapisz + status */}
        {activeTab === 'calculator' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={saveToSheets}
              disabled={isSaving}
              style={{
                padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: isSaving ? 'wait' : 'pointer',
                border: 'none', background: sheetsConnected ? '#10b981' : '#475569',
                color: 'white', opacity: isSaving ? 0.7 : 1, whiteSpace: 'nowrap',
              }}
            >
              {isSaving ? '⏳ Zapisywanie...' : '💾 Zapisz do budżetu'}
            </button>
            {saveMsg && (
              <span style={{ fontSize: 12, color: saveMsg.type === 'ok' ? '#6ee7b7' : '#fca5a5', fontWeight: 600 }}>
                {saveMsg.text}
              </span>
            )}
            {!sheetsConnected && APPS_SCRIPT_URL !== 'YOUR_APPS_SCRIPT_URL_HERE' && (
              <span style={{ fontSize: 11, color: '#f59e0b' }}>⚠ Brak połączenia z Sheets</span>
            )}
            {APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE' && (
              <span style={{ fontSize: 11, color: '#94a3b8' }}>⚙ Skonfiguruj Apps Script URL</span>
            )}
          </div>
        )}

        <button
          onClick={() => setShowYearPanel(p => !p)}
          style={{
            marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: showYearPanel ? '1px solid #06b6d4' : '1px solid #475569',
            background: showYearPanel ? '#06b6d4' : '#334155', color: 'white', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: 14 }}>&#9881;</span> Ustawienia roku {yearSettings.year}
        </button>
      </div>

      {/* YEAR SETTINGS PANEL */}
      {showYearPanel && (
        <div style={{
          background: '#ecfeff', borderBottom: '2px solid #06b6d4', padding: '12px 20px',
          display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#0e7490', textTransform: 'uppercase' }}>Parametry roku {yearSettings.year}</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <label style={{ fontSize: 10, color: '#78716c' }}>Rok</label>
                <input type="number" value={yearSettings.year} step={1}
                  onChange={e => updateYearSettings({ year: parseInt(e.target.value) || 2026 })}
                  style={{ width: 70, padding: '3px 6px', fontSize: 12, border: '1px solid #d6d3d1', borderRadius: 4, textAlign: 'right' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <label style={{ fontSize: 10, color: '#78716c' }}>30-krotność (ZUS)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="number" value={yearSettings.zusLimit} step={100}
                    onChange={e => updateYearSettings({ zusLimit: parseFloat(e.target.value) || 0 })}
                    style={{ width: 90, padding: '3px 6px', fontSize: 12, border: '1px solid #d6d3d1', borderRadius: 4, textAlign: 'right' }} />
                  <span style={{ fontSize: 11, color: '#78716c' }}>zł</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <label style={{ fontSize: 10, color: '#78716c' }}>Minimalne wynagrodzenie</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="number" value={yearSettings.minWage} step={1}
                    onChange={e => updateYearSettings({ minWage: parseFloat(e.target.value) || 0 })}
                    style={{ width: 90, padding: '3px 6px', fontSize: 12, border: '1px solid #d6d3d1', borderRadius: 4, textAlign: 'right' }} />
                  <span style={{ fontSize: 11, color: '#78716c' }}>zł</span>
                </div>
              </div>
            </div>
          </div>

          <div style={{ width: 1, background: '#cffafe', alignSelf: 'stretch' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#0e7490', textTransform: 'uppercase' }}>Spółki ({companies.length})</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {companies.map(co => (
                <div key={co.id} style={{
                  background: '#fff', border: '1px solid #d6d3d1', borderRadius: 6, padding: '6px 10px', fontSize: 11,
                  display: 'flex', flexDirection: 'column', gap: 2, minWidth: 140,
                }}>
                  <div style={{ fontWeight: 600, color: '#1e293b' }}>{co.name}</div>
                  <div style={{ color: '#78716c', fontSize: 10 }}>Wyp: {co.wypadkowa}% | FP: {co.fp}% | FGŚP: {co.fgsp}%</div>
                </div>
              ))}
              <button
                onClick={() => addCompany('Nowa spółka')}
                style={{
                  padding: '6px 10px', fontSize: 11, borderRadius: 6, border: '1px dashed #06b6d4',
                  background: 'transparent', color: '#06b6d4', cursor: 'pointer', fontWeight: 600,
                }}
              >+ Dodaj spółkę</button>
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>
              Dane spółek (wypadkowa, FP, PPK) ustawiasz przy umowie klikając "Wybierz spółkę"
            </div>
          </div>
        </div>
      )}

      {/* COMPANY EDIT POPOVER — when editing company for a contract */}
      {editingCompanyForContract && (() => {
        const contractForEdit = contracts.find(c => c.id === editingCompanyForContract);
        const currentCompId = contractForEdit?.companyId;
        return (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
          }} onClick={() => setEditingCompanyForContract(null)}>
            <div style={{
              background: 'white', borderRadius: 12, padding: 20, minWidth: 500, maxWidth: 600,
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }} onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Wybierz spółkę dla umowy</div>

              {/* Company list to pick from */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {companies.map(co => (
                  <button key={co.id} onClick={() => {
                    assignCompany(editingCompanyForContract, co.id);
                  }} style={{
                    padding: '8px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                    border: currentCompId === co.id ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                    background: currentCompId === co.id ? '#eff6ff' : 'white', fontWeight: currentCompId === co.id ? 700 : 400,
                  }}>{co.name}</button>
                ))}
                <button onClick={() => {
                  const nid = addCompany('Nowa spółka');
                  assignCompany(editingCompanyForContract, nid);
                }} style={{
                  padding: '8px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  border: '1px dashed #94a3b8', background: 'transparent', color: '#64748b',
                }}>+ Nowa spółka</button>
              </div>

              {/* Edit selected company details */}
              {currentCompId && (() => {
                const co = companies.find(c => c.id === currentCompId);
                if (!co) return null;
                return (
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8 }}>Dane spółki: {co.name}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <label style={{ fontSize: 11, color: '#78716c', minWidth: 50 }}>Nazwa:</label>
                      <input value={co.name} onChange={e => updateCompany(co.id, { name: e.target.value })}
                        style={{ flex: 1, padding: '4px 8px', fontSize: 12, border: '1px solid #d6d3d1', borderRadius: 4 }} />
                      <label style={{ fontSize: 11, color: '#78716c' }}>PKD:</label>
                      <input value={co.pkd} onChange={e => updateCompany(co.id, { pkd: e.target.value })} placeholder="np. 62.01.Z"
                        style={{ width: 90, padding: '4px 8px', fontSize: 12, border: '1px solid #d6d3d1', borderRadius: 4 }} />
                      <label style={{ fontSize: 11, color: '#78716c' }}>NIP:</label>
                      <input value={co.nip} onChange={e => updateCompany(co.id, { nip: e.target.value })} placeholder="000-000-00-00"
                        style={{ width: 110, padding: '4px 8px', fontSize: 12, border: '1px solid #d6d3d1', borderRadius: 4 }} />
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 4, marginTop: 8 }}>Składki pracodawcy (%)</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                      {[
                        { key: 'wypadkowa', label: 'Wypadkowa', step: 0.01 },
                        { key: 'fp', label: 'Fundusz Pracy', step: 0.01 },
                        { key: 'fgsp', label: 'FGŚP', step: 0.01 },
                        { key: 'fep', label: 'FEP', step: 0.1 },
                      ].map(f => (
                        <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <label style={{ fontSize: 10, color: '#78716c' }}>{f.label}</label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <input type="number" value={co[f.key]} step={f.step}
                              onChange={e => updateCompany(co.id, { [f.key]: parseFloat(e.target.value) || 0 })}
                              style={{ width: 55, padding: '3px 5px', fontSize: 11, border: '1px solid #d6d3d1', borderRadius: 3, textAlign: 'right' }} />
                            <span style={{ fontSize: 10, color: '#78716c' }}>%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 4 }}>PPK (%)</div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      {[
                        { key: 'ppkERBasic', label: 'Pracodawca baz.', step: 0.5 },
                        { key: 'ppkERExtra', label: 'Pracodawca dod.', step: 0.5 },
                        { key: 'ppkEEBasic', label: 'Pracownik baz.', step: 0.5 },
                      ].map(f => (
                        <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <label style={{ fontSize: 10, color: '#78716c' }}>{f.label}</label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <input type="number" value={co[f.key]} step={f.step}
                              onChange={e => updateCompany(co.id, { [f.key]: parseFloat(e.target.value) || 0 })}
                              style={{ width: 55, padding: '3px 5px', fontSize: 11, border: '1px solid #d6d3d1', borderRadius: 3, textAlign: 'right' }} />
                            <span style={{ fontSize: 10, color: '#78716c' }}>%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={() => setEditingCompanyForContract(null)}
                  style={{ padding: '6px 20px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: '#3b82f6', color: 'white', border: 'none', cursor: 'pointer' }}
                >Gotowe</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── ZAKŁADKA BUDŻET ─────────────────────────────────────────────── */}
      {activeTab === 'budget' && (
        <BudgetTab
          budgetPersons={budgetPersons}
          sheetData={sheetData}
          sheetsConnected={sheetsConnected}
          year={yearSettings.year}
          onDelete={deleteFromBudget}
          onLoad={loadPersonToCalculator}
          appsScriptUrl={APPS_SCRIPT_URL}
        />
      )}

      {/* ── ZAKŁADKA KALKULATOR ──────────────────────────────────────────── */}
      {activeTab === 'calculator' && <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* LEFT: CONTRACT ROWS + MONTHS GRID */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* CONTRACTS TABLE */}
          <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Umowy</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
                {CONTRACT_TYPES.map(ct => (
                  <button
                    key={ct.id}
                    onClick={() => addContract(ct.id)}
                    style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, border: `1px solid ${ct.color}`, background: 'white', color: ct.color, cursor: 'pointer', fontWeight: 600 }}
                  >
                    + {ct.short}
                  </button>
                ))}
                {/* Inne — expandable aliases dropdown */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setShowInneDropdown(p => !p)}
                    style={{
                      padding: '4px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                      border: showInneDropdown ? '1px solid #6366f1' : '1px solid #94a3b8',
                      background: showInneDropdown ? '#eef2ff' : 'white',
                      color: showInneDropdown ? '#4f46e5' : '#64748b',
                    }}
                  >
                    + Inne {showInneDropdown ? '▲' : '▼'}
                  </button>
                  {showInneDropdown && (<>
                    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 }} onClick={() => setShowInneDropdown(false)} />
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 50,
                      background: 'white', border: '1px solid #e2e8f0', borderRadius: 8,
                      boxShadow: '0 8px 30px rgba(0,0,0,0.15)', minWidth: 260, padding: 4,
                    }}>
                      {CONTRACT_ALIASES.map(alias => (
                        <button
                          key={alias.id}
                          onClick={() => addContract(alias.mapsTo, alias.id)}
                          style={{
                            display: 'flex', flexDirection: 'column', gap: 1, width: '100%',
                            padding: '8px 10px', border: 'none', borderRadius: 6,
                            background: 'transparent', cursor: 'pointer', textAlign: 'left',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = '#f1f5f9'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: alias.color, flexShrink: 0 }} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#1e293b' }}>{alias.label}</span>
                          </div>
                          <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 14 }}>{alias.desc}</span>
                        </button>
                      ))}
                    </div>
                  </>)}
                </div>
              </div>
            </div>

            {contracts.map((c, ci) => {
              const ct = CT_MAP[c.ct];
              const isSelected = c.id === selectedId;
              return (
                <div
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  style={{
                    display: 'flex', flexDirection: 'column', marginBottom: 8,
                    border: isSelected ? `2px solid ${ct.color}` : '1px solid #e2e8f0',
                    borderRadius: 8, background: isSelected ? '#f0f9ff' : 'white', cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {/* Contract header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #e2e8f0' }}>
                    {(() => {
                      const alias = c.aliasId ? CONTRACT_ALIASES.find(a => a.id === c.aliasId) : null;
                      const dotColor = alias ? alias.color : ct.color;
                      const shortLabel = alias ? alias.short : ct.short;
                      return (<>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: dotColor, minWidth: 60 }}>{shortLabel}</span>
                      </>);
                    })()}
                    <input
                      value={c.label}
                      onChange={e => updateContract(c.id, { label: e.target.value })}
                      placeholder="Etykieta umowy (opcjonalna)..."
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, outline: 'none', padding: '2px 4px' }}
                    />

                    {/* Company picker button */}
                    <button
                      onClick={e => { e.stopPropagation(); setEditingCompanyForContract(c.id); }}
                      style={{
                        padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                        border: c.companyId ? '1px solid #f59e0b' : '1px dashed #94a3b8',
                        background: c.companyId ? '#fef3c7' : 'transparent',
                        color: c.companyId ? '#92400e' : '#64748b', fontWeight: c.companyId ? 600 : 400,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.companyId ? (companies.find(co => co.id === c.companyId)?.name || 'Wybierz spółkę') : 'Wybierz spółkę'}
                    </button>

                    {/* Budget line selector — opcjonalne przypisanie do pozycji budżetowej */}
                    {sheetsConnected && sheetData.budgetLines.length > 0 && (
                      <select
                        value={c.budgetLineId || ''}
                        onChange={e => updateContract(c.id, { budgetLineId: e.target.value })}
                        onClick={ev => ev.stopPropagation()}
                        title="Przypisz do pozycji budżetowej projektu"
                        style={{
                          padding: '2px 6px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                          border: c.budgetLineId ? '1px solid #6366f1' : '1px dashed #94a3b8',
                          background: c.budgetLineId ? '#eef2ff' : 'transparent',
                          color: c.budgetLineId ? '#4338ca' : '#64748b', fontWeight: c.budgetLineId ? 600 : 400,
                          maxWidth: 160,
                        }}
                      >
                        <option value="">Brak projektu</option>
                        {sheetData.projects.map(proj => (
                          <optgroup key={proj.project_id} label={proj.project_name}>
                            {sheetData.budgetLines
                              .filter(bl => bl.project_id === proj.project_id)
                              .map(bl => (
                                <option key={bl.budget_line_id} value={bl.budget_line_id}>
                                  {bl.budget_line_name}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                    )}

                    {/* Input mode toggle — for contracts where employer cost ≠ brutto */}
                    {(c.ct === 'uop' || c.ct === 'zlecenie_full' || c.ct === 'dzielo_50kup' || c.ct === 'powolanie') && (
                      <div style={{ display: 'flex', gap: 2, background: c.ct === 'uop' ? '#dbeafe' : c.ct === 'zlecenie_full' ? '#ede9fe' : c.ct === 'powolanie' ? '#dbeafe' : '#fef3c7', borderRadius: 4, padding: 1 }}>
                        <button
                          onClick={e => { e.stopPropagation(); updateContract(c.id, { inputMode: 'employer' }); }}
                          style={{ padding: '2px 6px', fontSize: 10, borderRadius: 3, border: 'none', cursor: 'pointer', background: c.inputMode === 'employer' ? 'white' : 'transparent', fontWeight: c.inputMode === 'employer' ? 600 : 400 }}
                        >Koszt prac.</button>
                        <button
                          onClick={e => { e.stopPropagation(); updateContract(c.id, { inputMode: 'brutto' }); }}
                          style={{ padding: '2px 6px', fontSize: 10, borderRadius: 3, border: 'none', cursor: 'pointer', background: c.inputMode === 'brutto' ? 'white' : 'transparent', fontWeight: c.inputMode === 'brutto' ? 600 : 400 }}
                        >Brutto</button>
                      </div>
                    )}

                    {/* Mode toggle */}
                    <div style={{ display: 'flex', gap: 2, background: '#e2e8f0', borderRadius: 4, padding: 1 }}>
                      <button
                        onClick={e => { e.stopPropagation(); updateContract(c.id, { mode: 'fixed' }); }}
                        style={{ padding: '2px 6px', fontSize: 10, borderRadius: 3, border: 'none', cursor: 'pointer', background: c.mode === 'fixed' ? 'white' : 'transparent', fontWeight: c.mode === 'fixed' ? 600 : 400 }}
                      >Stała</button>
                      <button
                        onClick={e => { e.stopPropagation(); updateContract(c.id, { mode: 'monthly' }); }}
                        style={{ padding: '2px 6px', fontSize: 10, borderRadius: 3, border: 'none', cursor: 'pointer', background: c.mode === 'monthly' ? 'white' : 'transparent', fontWeight: c.mode === 'monthly' ? 600 : 400 }}
                      >Per miesiąc</button>
                    </div>

                    <button
                      onClick={e => { e.stopPropagation(); removeContract(c.id); }}
                      style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
                    >×</button>
                  </div>

                  {/* Amount inputs */}
                  <div style={{ padding: '6px 12px', display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    {c.mode === 'fixed' ? (
                      <>
                        <label style={{ fontSize: 11, color: '#64748b', minWidth: 80 }}>{c.ct === 'b2b' ? 'Netto faktury:' : c.inputMode === 'brutto' ? 'Brutto/mies.:' : 'Koszt prac./mies.:'}</label>
                        <input
                          type="number"
                          value={c.fixedAmount || ''}
                          onChange={e => updateContract(c.id, { fixedAmount: parseFloat(e.target.value) || 0 })}
                          onClick={e => e.stopPropagation()}
                          placeholder="0"
                          style={{ width: 100, padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 12, textAlign: 'right' }}
                        />
                        <span style={{ fontSize: 11, color: '#64748b' }}>zł</span>
                        {c.ct === 'uop' && c.inputMode === 'brutto' && (
                          <>
                            <span style={{ fontSize: 11, color: '#94a3b8', margin: '0 4px' }}>|</span>
                            <label style={{ fontSize: 11, color: '#64748b' }}>w tym chorobowe:</label>
                            <input
                              type="number"
                              value={c.sickPay || ''}
                              onChange={e => updateContract(c.id, { sickPay: parseFloat(e.target.value) || 0 })}
                              onClick={e => e.stopPropagation()}
                              placeholder="0"
                              style={{ width: 80, padding: '3px 6px', border: '1px solid #fbbf24', borderRadius: 4, fontSize: 12, textAlign: 'right', background: '#fffbeb' }}
                            />
                            <span style={{ fontSize: 11, color: '#64748b' }}>zł</span>
                            <span style={{ fontSize: 11, color: '#94a3b8', margin: '0 4px' }}>|</span>
                            <label style={{ fontSize: 11, color: '#64748b' }}>zasiłek ZUS:</label>
                            <input
                              type="number"
                              value={c.zasilekZUS || ''}
                              onChange={e => updateContract(c.id, { zasilekZUS: parseFloat(e.target.value) || 0 })}
                              onClick={e => e.stopPropagation()}
                              placeholder="0"
                              title="Zasiłek chorobowy/macierzyński (wypłacany przez ZUS) — bez ZUS, bez zdrowotnej, bez KUP"
                              style={{ width: 80, padding: '3px 6px', border: '1px solid #c084fc', borderRadius: 4, fontSize: 12, textAlign: 'right', background: '#faf5ff' }}
                            />
                            <span style={{ fontSize: 11, color: '#64748b' }}>zł</span>
                          </>
                        )}
                        {c.ct === 'uop' && c.inputMode === 'brutto' && (
                          <div style={{ width: '100%', fontSize: 10, color: '#94a3b8', fontStyle: 'italic', marginTop: 2 }}>
                            Wpisz "Podsumowanie" z listy płac. "chorobowe" = wynagr. chorobowe (pracodawca, zdrowotna SIĘ nalicza). "zasiłek ZUS" = zasiłek chorobowy/macierzyński (ZUS wypłaca, zdrowotna = 0, KUP = 0).
                          </div>
                        )}
                        <span style={{ fontSize: 11, color: '#94a3b8', margin: '0 6px' }}>|</span>
                        <label style={{ fontSize: 11, color: '#64748b' }}>Od:</label>
                        <select
                          value={c.startMonth}
                          onChange={e => { e.stopPropagation(); updateContract(c.id, { startMonth: parseInt(e.target.value) }); }}
                          onClick={e => e.stopPropagation()}
                          style={{ padding: '2px 4px', fontSize: 11, border: '1px solid #cbd5e1', borderRadius: 4 }}
                        >
                          {MONTH_LABELS.map((ml, i) => <option key={i} value={i}>{ml}</option>)}
                        </select>
                        <label style={{ fontSize: 11, color: '#64748b' }}>Do:</label>
                        <select
                          value={c.endMonth}
                          onChange={e => { e.stopPropagation(); updateContract(c.id, { endMonth: parseInt(e.target.value) }); }}
                          onClick={e => e.stopPropagation()}
                          style={{ padding: '2px 4px', fontSize: 11, border: '1px solid #cbd5e1', borderRadius: 4 }}
                        >
                          {MONTH_LABELS.map((ml, i) => <option key={i} value={i}>{ml}</option>)}
                        </select>
                      </>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', width: '100%' }}>
                        {MONTHS.map((_, m) => (
                          <div key={m} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 80, flex: 1 }}>
                            <span style={{ fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>{MONTH_LABELS[m]}</span>
                            <input
                              type="number"
                              value={c.monthlyAmounts[m] || ''}
                              onChange={e => {
                                const a = [...c.monthlyAmounts];
                                a[m] = parseFloat(e.target.value) || 0;
                                updateContract(c.id, { monthlyAmounts: a });
                              }}
                              onClick={e => e.stopPropagation()}
                              placeholder={c.ct === 'b2b' ? 'netto fv' : c.inputMode === 'brutto' ? 'brutto' : 'koszt'}
                              style={{ width: '100%', padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: 3, fontSize: 11, textAlign: 'right' }}
                            />
                            {c.ct === 'uop' && c.inputMode === 'brutto' && (
                              <input
                                type="number"
                                value={c.monthlySickPay?.[m] || ''}
                                onChange={e => {
                                  const s = [...(c.monthlySickPay || Array(12).fill(0))];
                                  s[m] = parseFloat(e.target.value) || 0;
                                  updateContract(c.id, { monthlySickPay: s });
                                }}
                                onClick={e => e.stopPropagation()}
                                placeholder="chor."
                                title="Wynagrodzenie chorobowe (pracodawca)"
                                style={{ width: '100%', padding: '2px 4px', border: '1px solid #fbbf24', borderRadius: 3, fontSize: 10, textAlign: 'right', background: '#fffbeb', color: '#92400e' }}
                              />
                            )}
                            {c.ct === 'uop' && c.inputMode === 'brutto' && (
                              <input
                                type="number"
                                value={c.monthlyZasilekZUS?.[m] || ''}
                                onChange={e => {
                                  const z = [...(c.monthlyZasilekZUS || Array(12).fill(0))];
                                  z[m] = parseFloat(e.target.value) || 0;
                                  updateContract(c.id, { monthlyZasilekZUS: z });
                                }}
                                onClick={e => e.stopPropagation()}
                                placeholder="zasił."
                                title="Zasiłek chorobowy/macierzyński (ZUS)"
                                style={{ width: '100%', padding: '2px 4px', border: '1px solid #c084fc', borderRadius: 3, fontSize: 10, textAlign: 'right', background: '#faf5ff', color: '#7c3aed' }}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Monthly results mini-strip */}
                  <div style={{ display: 'flex', gap: 1, padding: '4px 12px 6px', background: '#f8fafc' }}>
                    {MONTHS.map((_, m) => {
                      const r = results.monthly[ci]?.[m];
                      const active = r != null;
                      return (
                        <div key={m} style={{
                          flex: 1, textAlign: 'center', fontSize: 9, padding: '2px 0',
                          borderRadius: 2, background: active ? ct.color + '18' : 'transparent',
                          color: active ? ct.color : '#cbd5e1',
                        }}>
                          {active ? fmtShort(r.netto) : '—'}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* BOTTOM: PODSUMOWANIE PRACOWNIK */}
          <div style={{ borderTop: '2px solid #0f766e', background: '#134e4a', color: 'white', padding: '10px 16px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Podsumowanie Pracownik {personName ? `— ${personName}` : ''}</span>
              <span style={{ fontSize: 11, opacity: 0.6 }}>Prognoza kwot na rękę po wszystkich kosztach</span>
            </div>

            {/* Monthly na rękę strip with hover tooltips */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {results.totals.map((t, m) => (
                <div key={m} style={{ flex: 1, position: 'relative' }}
                  onMouseEnter={() => setHoveredSummaryMonth(m)}
                  onMouseLeave={() => setHoveredSummaryMonth(null)}
                >
                  <div style={{ background: hoveredSummaryMonth === m ? '#1e6d66' : '#1a5c56', borderRadius: 4, padding: '6px 4px', textAlign: 'center', cursor: 'default', transition: 'background 0.15s' }}>
                    <div style={{ fontSize: 9, opacity: 0.6, textTransform: 'uppercase' }}>{MONTH_LABELS[m]}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6ee7b7' }}>{t.naReke > 0 ? fmtShort(t.naReke) : '—'}</div>
                  </div>
                  {/* Tooltip */}
                  {hoveredSummaryMonth === m && (() => {
                    // Build per-contract breakdown for this month
                    const details = contracts.map((c, ci) => {
                      const r = results.monthly[ci][m];
                      if (!r) return null;
                      const ct = CT_MAP[c.ct];
                      const label = c.label || ct?.short || c.ct;
                      const isB2B = c.ct === 'b2b';
                      const cn = isB2B ? r.contractorNetto : null;
                      return { label, ct: c.ct, r, cn };
                    }).filter(Boolean);
                    if (details.length === 0) return null;
                    return (
                      <div style={{
                        position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                        marginBottom: 8, minWidth: 260, maxWidth: 320, zIndex: 200,
                        background: '#0f2a27', border: '1px solid #2dd4bf', borderRadius: 8,
                        padding: '10px 12px', boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                        fontSize: 11, color: '#e2e8f0', pointerEvents: 'none',
                      }}>
                        {/* Arrow */}
                        <div style={{
                          position: 'absolute', bottom: -6, left: '50%', transform: 'translateX(-50%)',
                          width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                          borderTop: '6px solid #2dd4bf',
                        }} />
                        <div style={{ fontWeight: 700, fontSize: 12, color: '#2dd4bf', marginBottom: 6, borderBottom: '1px solid #1a3d38', paddingBottom: 4 }}>
                          {MONTH_LABELS_FULL[m]} — rozbicie kosztów
                        </div>
                        {details.map((d, di) => (
                          <div key={di} style={{ marginBottom: di < details.length - 1 ? 8 : 0 }}>
                            <div style={{ fontWeight: 600, color: CT_MAP[d.ct]?.color || '#fff', marginBottom: 3, fontSize: 11 }}>
                              {d.label}
                            </div>
                            {d.ct === 'b2b' && d.cn ? (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1px 8px', fontSize: 10 }}>
                                <span style={{ opacity: 0.6 }}>Przychód:</span><span style={{ textAlign: 'right' }}>{fmt(d.cn.przychod)}</span>
                                <span style={{ opacity: 0.6 }}>ZUS społeczny:</span><span style={{ textAlign: 'right' }}>{fmt(d.cn.zusSoc)}</span>
                                <span style={{ opacity: 0.6 }}>Zdrowotna:</span><span style={{ textAlign: 'right' }}>{fmt(d.cn.zdrowotna)}</span>
                                {d.cn.zdrowotnaDeducted > 0 && <>
                                  <span style={{ opacity: 0.5, fontStyle: 'italic' }}>&nbsp;&nbsp;w tym odliczona:</span><span style={{ textAlign: 'right', opacity: 0.5, fontStyle: 'italic' }}>{fmt(d.cn.zdrowotnaDeducted)}</span>
                                </>}
                                <span style={{ opacity: 0.6 }}>PIT:</span><span style={{ textAlign: 'right' }}>{fmt(d.cn.pit)}</span>
                                <span style={{ opacity: 0.6 }}>Księgowość:</span><span style={{ textAlign: 'right' }}>{fmt(d.cn.ksiegowosc)}</span>
                                <span style={{ borderTop: '1px solid #2a5a54', paddingTop: 2, fontWeight: 600, color: '#6ee7b7' }}>Na rękę:</span>
                                <span style={{ borderTop: '1px solid #2a5a54', paddingTop: 2, textAlign: 'right', fontWeight: 700, color: '#6ee7b7' }}>{fmt(d.cn.nettoNaReke)}</span>
                              </div>
                            ) : d.r.isLeave ? (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1px 8px', fontSize: 10 }}>
                                <span style={{ opacity: 0.6 }}>Typ urlopu:</span><span style={{ textAlign: 'right' }}>{d.r.leaveType}</span>
                                <span style={{ opacity: 0.6 }}>Świadczenie ZUS:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.zusBenefit)}</span>
                                <span style={{ fontWeight: 600, color: '#fbbf24' }}>Koszt pracodawcy:</span>
                                <span style={{ textAlign: 'right', fontWeight: 700, color: '#fbbf24' }}>0,00 zł</span>
                              </div>
                            ) : (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1px 8px', fontSize: 10 }}>
                                {d.r.brutto != null && <><span style={{ opacity: 0.6 }}>Brutto:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.brutto)}</span></>}
                                {d.r.l4Info && <>
                                  <span style={{ opacity: 0.5, fontStyle: 'italic', color: '#fbbf24' }}>&nbsp;&nbsp;↳ przeprac. {d.r.l4Info.workedDays}d + chor. {d.r.l4Info.employerSickDays}d prac. + {d.r.l4Info.zusSickDays}d ZUS</span>
                                  <span style={{ textAlign: 'right', opacity: 0.5, fontStyle: 'italic', color: '#fbbf24' }}>({d.r.l4Info.sickDays}d L4)</span>
                                </>}
                                {d.r.socEE > 0 && <><span style={{ opacity: 0.6 }}>ZUS pracownik:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.socEE)}</span></>}
                                {d.r.zusER > 0 && <><span style={{ opacity: 0.6 }}>ZUS pracodawca:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.zusER)}</span></>}
                                {d.r.health > 0 && <><span style={{ opacity: 0.6 }}>Zdrowotna:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.health)}</span></>}
                                <span style={{ opacity: 0.6 }}>PIT:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.pit)}</span>
                                {(d.r.ppkEE > 0 || d.r.ppkER > 0) && <><span style={{ opacity: 0.6 }}>PPK (EE+ER):</span><span style={{ textAlign: 'right' }}>{fmt(d.r.ppkEE + d.r.ppkER)}</span></>}
                                {d.r.potracenie > 0 && <><span style={{ opacity: 0.6 }}>Potrącenie:</span><span style={{ textAlign: 'right' }}>{fmt(d.r.potracenie)}</span></>}
                                <span style={{ borderTop: '1px solid #2a5a54', paddingTop: 2, fontWeight: 600, color: '#6ee7b7' }}>Netto:</span>
                                <span style={{ borderTop: '1px solid #2a5a54', paddingTop: 2, textAlign: 'right', fontWeight: 700, color: '#6ee7b7' }}>{fmt(d.r.netto)}</span>
                                {d.r.totalCost != null && <><span style={{ opacity: 0.4, fontSize: 9 }}>Koszt pracodawcy:</span><span style={{ textAlign: 'right', opacity: 0.4, fontSize: 9 }}>{fmt(d.r.totalCost)}</span></>}
                              </div>
                            )}
                          </div>
                        ))}
                        {details.length > 1 && (
                          <div style={{ borderTop: '1px solid #2dd4bf', marginTop: 6, paddingTop: 4, display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#2dd4bf' }}>
                            <span>RAZEM na rękę:</span>
                            <span>{fmt(t.naReke)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
              <div style={{ minWidth: 90, background: '#10b981', borderRadius: 4, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, opacity: 0.8 }}>ROCZNIE</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{fmt(results.annual.naReke)}</div>
              </div>
            </div>
            <div style={{ fontSize: 10, opacity: 0.5 }}>
              Na rękę = netto po odliczeniu ZUS, zdrowotnej, PIT, księgowości i innych kosztów DG (B2B). Średnio/mies.: {fmt(results.annual.naReke / 12)}
            </div>
          </div>

          {/* BOTTOM: PODSUMOWANIE HUGETECH */}
          <div style={{ borderTop: '2px solid #1e293b', background: '#1e293b', color: 'white', padding: '10px 16px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Podsumowanie Pracodawca</span>
              <span style={{ fontSize: 11, opacity: 0.5 }}>Perspektywa pracodawcy (koszty firmy)</span>
            </div>

            {/* Annual summary boxes */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
              {[
                { label: 'Koszt pracodawcy', val: results.annual.totalCost, color: '#ef4444' },
                { label: 'Brutto', val: results.annual.totalBrutto, color: '#f59e0b' },
                { label: 'ZUS pracownik', val: results.annual.totalZUS_EE, color: '#8b5cf6' },
                { label: 'ZUS pracodawca', val: results.annual.totalZUS_ER, color: '#a78bfa' },
                { label: 'Zdrowotna', val: results.annual.totalHealth, color: '#06b6d4' },
                { label: 'PIT', val: results.annual.totalPIT, color: '#f97316' },
                { label: 'Netto', val: results.annual.totalNetto, color: '#10b981' },
              ].map((item, i) => (
                <div key={i} style={{ flex: 1, background: '#334155', borderRadius: 6, padding: '8px 10px', borderLeft: `3px solid ${item.color}` }}>
                  <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>{item.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{fmt(item.val)}</div>
                  <div style={{ fontSize: 10, opacity: 0.5 }}>/mies. ~{fmt(item.val / 12)}</div>
                </div>
              ))}
            </div>

            {/* Monthly chart */}
            <div style={{ height: 130 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={results.totals} margin={{ top: 5, right: 5, bottom: 0, left: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#475569" />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => (v / 1000).toFixed(0) + 'k'} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 6, fontSize: 11 }}
                    labelStyle={{ color: '#94a3b8' }}
                    formatter={(v, name) => [fmt(v), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="totalCost" name="Koszt" fill="#ef4444" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="totalNetto" name="Netto" fill="#10b981" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="totalPIT" name="PIT" fill="#f97316" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="totalZUS_ER" name="ZUS ER" fill="#a78bfa" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: Contract Options */}
        <div style={{ width: 300, borderLeft: '1px solid #e2e8f0', background: 'white', overflow: 'auto', flexShrink: 0 }}>
          {selected ? (
            <div style={{ padding: 16 }}>
              {(() => {
                const alias = selected.aliasId ? CONTRACT_ALIASES.find(a => a.id === selected.aliasId) : null;
                const headerColor = alias ? alias.color : CT_MAP[selected.ct].color;
                const headerLabel = alias ? alias.label : CT_MAP[selected.ct].label;
                return (<>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, color: headerColor }}>
                    {headerLabel}
                  </div>
                  {alias && (
                    <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2, fontStyle: 'italic' }}>
                      Logika: {CT_MAP[selected.ct].label}
                    </div>
                  )}
                </>);
              })()}
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 16 }}>
                {selected.label || 'Parametry umowy'}
              </div>

              {/* UoP Options */}
              {selected.ct === 'uop' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <OptionGroup label="Koszty uzyskania przychodu (KUP)">
                    <SelectInput
                      value={selected.opts.kup}
                      onChange={v => updateOpts(selected.id, { kup: v })}
                      options={[
                        { value: 'standard', label: `Zwykłe (${PL.KUP_STANDARD} zł)` },
                        { value: 'commuter', label: `Dojazdowe (${PL.KUP_COMMUTER} zł)` },
                        { value: 'none', label: 'Brak (0 zł)' },
                      ]}
                    />
                  </OptionGroup>

                  <OptionGroup label="Upoważnienie do zmniejszenia zaliczki PIT">
                    <SelectInput
                      value={selected.opts.kwotaZmniejszajaca}
                      onChange={v => updateOpts(selected.id, { kwotaZmniejszajaca: parseInt(v) })}
                      options={KWOTA_ZMN_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                    />
                  </OptionGroup>

                  <OptionGroup label="Ulga dla młodych (do 26 lat)">
                    <ToggleInput
                      value={selected.opts.under26}
                      onChange={v => updateOpts(selected.id, { under26: v })}
                      labelOn="Tak (PIT = 0, limit roczny 85 528 zł)"
                      labelOff="Nie"
                    />
                  </OptionGroup>

                  <OptionGroup label="PPK (Pracownicze Plany Kapitałowe)">
                    <ToggleInput
                      value={selected.opts.ppkEE}
                      onChange={v => updateOpts(selected.id, { ppkEE: v, ppkER: v })}
                      labelOn={`Tak (pracow. ${PL.PPK_EE_BASIC * 100}% + pracodaw. ${PL.PPK_ER_BASIC * 100}%)`}
                      labelOff="Nie uczestniczy"
                    />
                  </OptionGroup>

                  <OptionGroup label="Praca zdalna — ryczałt (zwolniony z PIT/ZUS)">
                    <NumberInput
                      value={selected.opts.remoteAllowance}
                      onChange={v => updateOpts(selected.id, { remoteAllowance: v })}
                      suffix="zł/mies."
                      placeholder="0"
                    />
                  </OptionGroup>

                  <OptionGroup label="Benefity pracodawcy (MultiSport, Luxmed itp.)">
                    <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>Część pracodawcy (wpływa tylko na PIT)</div>
                    <NumberInput
                      value={selected.opts.benefitPITOnly}
                      onChange={v => updateOpts(selected.id, { benefitPITOnly: v })}
                      suffix="zł/mies."
                      placeholder="0"
                    />
                  </OptionGroup>

                  <OptionGroup label="Potrącenie pracownika (MultiSport)">
                    <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>Odliczenie z netto (wpłata pracownika)</div>
                    <NumberInput
                      value={selected.opts.potracenieNetto}
                      onChange={v => updateOpts(selected.id, { potracenieNetto: v })}
                      suffix="zł/mies."
                      placeholder="0"
                    />
                  </OptionGroup>

                  {/* L4 / Chorobowe */}
                  <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10, marginTop: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 12, color: '#b45309' }}>Zwolnienie lekarskie (L4)</span>
                      <div style={{ display: 'flex', gap: 2 }}>
                        {['manual', 'auto'].map(mode => (
                          <button key={mode} onClick={() => updateContract(selected.id, { l4Mode: mode })}
                            style={{
                              padding: '2px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer', fontWeight: 600,
                              border: selected.l4Mode === mode ? '1px solid #d97706' : '1px solid #e2e8f0',
                              background: selected.l4Mode === mode ? '#fef3c7' : 'white',
                              color: selected.l4Mode === mode ? '#92400e' : '#94a3b8',
                            }}
                          >{mode === 'manual' ? 'Kwoty ręcznie' : 'Z dni (auto)'}</button>
                        ))}
                      </div>
                    </div>

                    {selected.l4Mode === 'auto' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <label style={{ fontSize: 11, color: '#64748b', minWidth: 90 }}>Dni chorobowe:</label>
                          <NumberInput
                            value={selected.l4SickDays}
                            onChange={v => updateContract(selected.id, { l4SickDays: Math.max(0, Math.min(v, 30)) })}
                            suffix="dni/mies."
                            placeholder="0"
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <label style={{ fontSize: 11, color: '#64748b', minWidth: 90 }}>Pracownik 50+:</label>
                          <ToggleInput
                            value={selected.l4Over50}
                            onChange={v => updateContract(selected.id, { l4Over50: v })}
                            labelOn="Tak (limit 14 dni pracodawcy)"
                            labelOff="Nie (limit 33 dni pracodawcy)"
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <label style={{ fontSize: 11, color: '#64748b', minWidth: 90 }}>Powód:</label>
                          <SelectInput
                            value={selected.l4Reason}
                            onChange={v => updateContract(selected.id, { l4Reason: v })}
                            options={[
                              { value: 'standard', label: 'Zwykłe chorobowe (80%)' },
                              { value: 'pregnancy', label: 'Ciąża (100%)' },
                              { value: 'accident', label: 'Wypadek w pracy (100%)' },
                            ]}
                          />
                        </div>
                        <div style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic', lineHeight: 1.4 }}>
                          Silnik automatycznie oblicza: stawkę dzienną (brutto - skł. społ.) / 30 × stawka, podział dni pracodawca vs ZUS (kumulacja roczna), proporcjonalne brutto za przepracowane dni.
                          {selected.l4SickDays > 0 && selected.mode === 'fixed' && ' Użyj trybu "Per miesiąc" aby ustawić różne dni L4 w różnych miesiącach.'}
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>
                        Tryb ręczny — wpisz kwoty "w tym chorobowe" i "zasiłek ZUS" bezpośrednio w wierszu umowy (widoczne w trybie brutto). Przełącz na "Z dni (auto)" aby silnik obliczał kwoty automatycznie z liczby dni.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Powołanie Options */}
              {selected.ct === 'powolanie' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: 10, fontSize: 10, color: '#1e40af', lineHeight: 1.5 }}>
                    Powołanie (art. 201 KSH): <strong>brak składek społecznych</strong> (emerytalna, rentowa, chorobowa), brak FP/FGŚP, brak PPK.
                    Obowiązkowa <strong>zdrowotna 9%</strong> od brutto. PIT wg skali (12%/32%) z KUP 250 zł.
                    Koszt spółki = brutto.
                  </div>

                  <OptionGroup label="Koszty uzyskania przychodu (KUP)">
                    <SelectInput
                      value={selected.opts.kup}
                      onChange={v => updateOpts(selected.id, { kup: v })}
                      options={[
                        { value: 'standard', label: `Zwykłe (${PL.KUP_STANDARD} zł)` },
                        { value: 'none', label: 'Brak (0 zł)' },
                      ]}
                    />
                  </OptionGroup>

                  <OptionGroup label="Kwota zmniejszająca PIT (PIT-2)">
                    <SelectInput
                      value={selected.opts.kwotaZmniejszajaca}
                      onChange={v => updateOpts(selected.id, { kwotaZmniejszajaca: parseInt(v) })}
                      options={KWOTA_ZMN_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                    />
                  </OptionGroup>

                  <OptionGroup label="Ulga dla młodych (do 26 lat)">
                    <ToggleInput
                      value={selected.opts.under26}
                      onChange={v => updateOpts(selected.id, { under26: v })}
                      labelOn="Tak (PIT = 0, limit roczny 85 528 zł)"
                      labelOff="Nie"
                    />
                  </OptionGroup>
                </div>
              )}

              {/* Zlecenie Full Options */}
              {selected.ct === 'zlecenie_full' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <OptionGroup label="Zatrudniony u tego samego pracodawcy">
                    <ToggleInput
                      value={selected.opts.sameEmployer}
                      onChange={v => updateOpts(selected.id, { sameEmployer: v })}
                      labelOn="Tak (obowiązkowy pełny ZUS)"
                      labelOff="Nie (standardowe reguły)"
                    />
                  </OptionGroup>

                  <OptionGroup label="Student poniżej 26 lat">
                    <ToggleInput
                      value={selected.opts.student26}
                      onChange={v => updateOpts(selected.id, { student26: v })}
                      labelOn="Tak (netto = brutto, brak ZUS/PIT)"
                      labelOff="Nie"
                    />
                  </OptionGroup>

                  <OptionGroup label="Chorobowa (dobrowolna)">
                    <ToggleInput
                      value={selected.opts.chorobowa}
                      onChange={v => updateOpts(selected.id, { chorobowa: v })}
                      labelOn="Tak (2.45%)"
                      labelOff="Nie"
                    />
                  </OptionGroup>

                  <OptionGroup label="Upoważnienie do zmniejszenia zaliczki PIT">
                    <SelectInput
                      value={selected.opts.kwotaZmniejszajaca}
                      onChange={v => updateOpts(selected.id, { kwotaZmniejszajaca: parseInt(v) })}
                      options={KWOTA_ZMN_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                    />
                  </OptionGroup>

                  <OptionGroup label="50% KUP (prawa autorskie)">
                    <ToggleInput
                      value={selected.opts.kup50}
                      onChange={v => updateOpts(selected.id, { kup50: v })}
                      labelOn="Tak (limit roczny 120 000 zł)"
                      labelOff="Nie (standardowe 20% KUP)"
                    />
                  </OptionGroup>

                  <OptionGroup label="PPK">
                    <ToggleInput
                      value={selected.opts.ppkEE}
                      onChange={v => updateOpts(selected.id, { ppkEE: v, ppkER: v })}
                      labelOn="Tak"
                      labelOff="Nie"
                    />
                  </OptionGroup>
                </div>
              )}


              {/* B2B Options */}
              {selected.ct === 'b2b' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <OptionGroup label="Stawka VAT">
                    <SelectInput
                      value={selected.opts.vatRate}
                      onChange={v => updateOpts(selected.id, { vatRate: parseInt(v) })}
                      options={[
                        { value: 23, label: '23% (standard)' },
                        { value: 8, label: '8%' },
                        { value: 5, label: '5%' },
                        { value: 0, label: '0% / zwolniony' },
                      ]}
                    />
                  </OptionGroup>

                  <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
                      Szacunek netto kontrahenta "na rękę"
                    </div>
                  </div>

                  <OptionGroup label="Forma opodatkowania">
                    <SelectInput
                      value={selected.opts.taxForm}
                      onChange={v => updateOpts(selected.id, { taxForm: v })}
                      options={[
                        { value: 'liniowy', label: 'Liniowy (19%)' },
                        { value: 'ryczalt', label: 'Ryczałt' },
                        { value: 'skala', label: 'Skala podatkowa (12%/32%)' },
                      ]}
                    />
                  </OptionGroup>

                  {selected.opts.taxForm === 'ryczalt' && (
                    <OptionGroup label="Stawka ryczałtu">
                      <SelectInput
                        value={selected.opts.ryczaltRate}
                        onChange={v => updateOpts(selected.id, { ryczaltRate: parseFloat(v) })}
                        options={[
                          { value: 3, label: '3% (handel)' },
                          { value: 5.5, label: '5.5%' },
                          { value: 8.5, label: '8.5% (usługi)' },
                          { value: 10, label: '10%' },
                          { value: 12, label: '12% (IT)' },
                          { value: 14, label: '14%' },
                          { value: 15, label: '15% (wolne zaw.)' },
                          { value: 17, label: '17%' },
                        ]}
                      />
                    </OptionGroup>
                  )}

                  <OptionGroup label="Baza ZUS">
                    <SelectInput
                      value={selected.opts.zusBasis}
                      onChange={v => updateOpts(selected.id, { zusBasis: v })}
                      options={[
                        { value: 'full', label: 'Pełny ZUS (~1927 zł)' },
                        { value: 'pref', label: 'Preferencyjny (~421 zł)' },
                        { value: 'ulga_na_start', label: 'Ulga na start (tylko zdrow.)' },
                        { value: 'zbieg', label: 'Zbieg tytułów (tylko zdrow.)' },
                        { value: 'none', label: 'Brak ZUS' },
                      ]}
                    />
                  </OptionGroup>

                  <OptionGroup label="Księgowość">
                    <NumberInput
                      value={selected.opts.ksiegowosc}
                      onChange={v => updateOpts(selected.id, { ksiegowosc: v })}
                      suffix="zł/mies."
                    />
                  </OptionGroup>

                  <OptionGroup label="Inne koszty DG">
                    <NumberInput
                      value={selected.opts.inneCosts}
                      onChange={v => updateOpts(selected.id, { inneCosts: v })}
                      suffix="zł/mies."
                      placeholder="0"
                    />
                  </OptionGroup>

                  {/* Show contractor netto if computed */}
                  {(() => {
                    const firstResult = results.monthly[contracts.findIndex(c => c.id === selected.id)]?.find(r => r?.contractorNetto);
                    if (!firstResult?.contractorNetto) return null;
                    const cn = firstResult.contractorNetto;
                    return (
                      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: 10, fontSize: 11 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4, color: '#15803d' }}>Szacunek kontrahenta/mies.</div>
                        <div>Przychód: {fmt(cn.przychod)}</div>
                        <div>ZUS społeczny: {fmt(cn.zusSoc)}</div>
                        <div>Zdrowotna: {fmt(cn.zdrowotna)}</div>
                        <div>PIT: {fmt(cn.pit)}</div>
                        <div>Księgowość: {fmt(cn.ksiegowosc)}</div>
                        <div style={{ fontWeight: 700, marginTop: 4, color: '#15803d' }}>Na rękę: {fmt(cn.nettoNaReke)}</div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Dzieło Options */}
              {selected.ct === 'dzielo_50kup' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <OptionGroup label="Zatrudniony u tego samego pracodawcy">
                    <ToggleInput
                      value={selected.opts.sameEmployer}
                      onChange={v => updateOpts(selected.id, { sameEmployer: v })}
                      labelOn="Tak (obowiązkowy ZUS jak UoP)"
                      labelOff="Nie (brak ZUS, tylko PIT 12% po 50% KUP)"
                    />
                  </OptionGroup>

                  {!selected.opts.sameEmployer && (
                    <div style={{ color: '#94a3b8', fontSize: 11, padding: '8px 0', borderTop: '1px solid #e2e8f0', paddingTop: 8 }}>
                      PIT 12% naliczany po odliczeniu 50% KUP. Roczny limit 50% KUP: 120 000 zł.
                    </div>
                  )}
                </div>
              )}

              {/* Selected contract monthly detail */}
              {selected && (
                <div style={{ marginTop: 20, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 8 }}>Wynik miesięczny</div>
                  <div style={{ maxHeight: 300, overflow: 'auto' }}>
                    {MONTHS.map((_, m) => {
                      const ci = contracts.findIndex(c => c.id === selected.id);
                      const r = results.monthly[ci]?.[m];
                      if (!r) return (
                        <div key={m} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11, color: '#cbd5e1' }}>
                          <span>{MONTH_LABELS[m]}</span><span>—</span>
                        </div>
                      );
                      return (
                        <div key={m} style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                            <span>{MONTH_LABELS[m]}</span>
                            <span style={{ color: '#10b981' }}>{fmt(r.netto)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b' }}>
                            <span>Koszt: {fmt(r.totalCost)}</span>
                            <span>Brutto: {fmt(r.brutto)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 10 }}>
                            <span>ZUS ee: {fmt(r.socEE)} | er: {fmt(r.zusER)}</span>
                            <span>PIT: {fmt(r.pit)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: 20, color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>
              Wybierz umowę po lewej stronie, aby edytować parametry
            </div>
          )}
        </div>
      </div>}</div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGET TAB COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
const MONTH_LABELS_SHORT = ['Sty','Lut','Mar','Kwi','Maj','Cze','Lip','Sie','Wrz','Paź','Lis','Gru'];

function BudgetTab({ budgetPersons, sheetData, sheetsConnected, year, onDelete, onLoad, appsScriptUrl }) {
  const fmtBudget = v => v != null ? v.toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' zł' : '—';

  // Sumy miesięczne
  const monthTotals = MONTH_LABELS_SHORT.map((_, m) =>
    budgetPersons.reduce((sum, p) => sum + (p.monthly[m] || 0), 0)
  );
  const grandTotal = budgetPersons.reduce((sum, p) => sum + p.total, 0);

  // Zestawienie per projekt/pozycja budżetowa
  const { budgetLines = [], projects = [] } = sheetData;
  const blMap = {};
  budgetLines.forEach(bl => { blMap[bl.budget_line_id] = bl; });
  const projMap = {};
  projects.forEach(p => { projMap[p.project_id] = p; });

  // Oblicz wykorzystanie per budget_line
  const blUsage = {};
  (sheetData.savedContracts || []).forEach(c => {
    if (!c.budget_line_id) return;
    const start = parseInt(c.start_month) || 1;
    const end   = parseInt(c.end_month) || 12;
    const months = Math.max(0, end - start + 1);
    const total  = (parseFloat(c.amount_monthly_pln) || 0) * months;
    blUsage[c.budget_line_id] = (blUsage[c.budget_line_id] || 0) + total;
  });

  if (!sheetsConnected && appsScriptUrl === 'YOUR_APPS_SCRIPT_URL_HERE') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 40, color: '#64748b' }}>
        <div style={{ fontSize: 48 }}>⚙️</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b' }}>Google Sheets nie jest skonfigurowany</div>
        <div style={{ fontSize: 14, textAlign: 'center', maxWidth: 480 }}>
          Postępuj zgodnie z instrukcją konfiguracji, wklej URL Apps Script do pliku<br />
          i odśwież stronę. Dane będą tu widoczne automatycznie.
        </div>
      </div>
    );
  }

  if (budgetPersons.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 40, color: '#64748b' }}>
        <div style={{ fontSize: 48 }}>👥</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b' }}>Budżet osobowy jest pusty</div>
        <div style={{ fontSize: 14 }}>Przejdź do zakładki Kalkulator, skonfiguruj umowy i kliknij „Zapisz do budżetu".</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', background: '#f8fafc' }}>
      {/* TABELA OSOBOWA */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 10 }}>
          Budżet osobowy {year}
          <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 400, color: '#64748b' }}>
            {budgetPersons.length} {budgetPersons.length === 1 ? 'osoba' : 'osoby/osób'}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, background: 'white', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <thead>
              <tr style={{ background: '#1e293b', color: 'white' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' }}>Osoba</th>
                <th style={{ padding: '8px 8px', textAlign: 'left', fontWeight: 600 }}>Umowy</th>
                {MONTH_LABELS_SHORT.map(m => (
                  <th key={m} style={{ padding: '8px 6px', textAlign: 'right', fontWeight: 600, minWidth: 70 }}>{m}</th>
                ))}
                <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, background: '#0f172a' }}>Rok</th>
                <th style={{ padding: '8px 8px', textAlign: 'center', fontWeight: 400 }}></th>
              </tr>
            </thead>
            <tbody>
              {budgetPersons.map((p, pi) => (
                <tr key={p.pid} style={{ background: pi % 2 === 0 ? 'white' : '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap', color: '#1e293b' }}>{p.fullName}</td>
                  <td style={{ padding: '8px 8px', fontSize: 11, color: '#64748b' }}>
                    {p.contracts.map(c => c.contract_type).join(', ')}
                  </td>
                  {p.monthly.map((amt, m) => (
                    <td key={m} style={{ padding: '6px 6px', textAlign: 'right', color: amt > 0 ? '#1e293b' : '#cbd5e1' }}>
                      {amt > 0 ? fmtBudget(amt) : '—'}
                    </td>
                  ))}
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: '#10b981', background: '#f0fdf4' }}>
                    {fmtBudget(p.total)}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                    <button onClick={() => onLoad(p)} title="Wczytaj do kalkulatora" style={{ background: 'none', border: '1px solid #3b82f6', borderRadius: 4, color: '#3b82f6', cursor: 'pointer', padding: '2px 6px', fontSize: 10, marginRight: 4 }}>✎</button>
                    <button onClick={() => onDelete(p.fullName)} title="Usuń z budżetu" style={{ background: 'none', border: '1px solid #ef4444', borderRadius: 4, color: '#ef4444', cursor: 'pointer', padding: '2px 6px', fontSize: 10 }}>✕</button>
                  </td>
                </tr>
              ))}
              {/* Wiersz RAZEM */}
              <tr style={{ background: '#1e293b', color: 'white', fontWeight: 700 }}>
                <td style={{ padding: '8px 12px' }}>RAZEM</td>
                <td></td>
                {monthTotals.map((t, m) => (
                  <td key={m} style={{ padding: '6px 6px', textAlign: 'right', color: '#6ee7b7' }}>{fmtBudget(t)}</td>
                ))}
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#34d399', fontSize: 14 }}>{fmtBudget(grandTotal)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ZESTAWIENIE PER PROJEKT */}
      {budgetLines.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 10 }}>Wykorzystanie budżetów projektów</div>
          {projects.map(proj => {
            const lines = budgetLines.filter(bl => bl.project_id === proj.project_id);
            if (lines.length === 0) return null;
            return (
              <div key={proj.project_id} style={{ background: 'white', borderRadius: 8, padding: '12px 16px', marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 700, color: '#1e293b', marginBottom: 8, fontSize: 13 }}>
                  {proj.project_name}
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b', fontWeight: 400 }}>{proj.project_code}</span>
                </div>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>
                      <th style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600 }}>Pozycja budżetowa</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>Limit roczny</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>Zaplanowane</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>Pozostało</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(bl => {
                      const limit    = parseFloat(bl.budget_amount_annual_pln) || 0;
                      const used     = blUsage[bl.budget_line_id] || 0;
                      const remaining = limit - used;
                      const overrun  = remaining < 0;
                      return (
                        <tr key={bl.budget_line_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '6px 8px', color: '#334155' }}>{bl.budget_line_name}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#64748b' }}>{fmtBudget(limit)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: used > 0 ? '#1e293b' : '#cbd5e1' }}>{used > 0 ? fmtBudget(used) : '—'}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700,
                            color: overrun ? '#ef4444' : remaining === 0 ? '#f59e0b' : '#10b981' }}>
                            {overrun ? '⚠ ' : ''}{fmtBudget(remaining)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REUSABLE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════
function OptionGroup({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function SelectInput({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ width: '100%', padding: '5px 8px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4, background: 'white' }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ToggleInput({ value, onChange, labelOn, labelOff }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '5px 8px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4,
        background: value ? '#f0fdf4' : 'white', cursor: 'pointer', textAlign: 'left',
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: 3, border: '2px solid',
        borderColor: value ? '#10b981' : '#94a3b8', background: value ? '#10b981' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 10, flexShrink: 0,
      }}>
        {value ? '✓' : ''}
      </span>
      <span>{value ? labelOn : labelOff}</span>
    </button>
  );
}

function NumberInput({ value, onChange, suffix, placeholder }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        value={value || ''}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        placeholder={placeholder || '0'}
        style={{ flex: 1, padding: '5px 8px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 4, textAlign: 'right' }}
      />
      {suffix && <span style={{ fontSize: 11, color: '#64748b' }}>{suffix}</span>}
    </div>
  );
}
