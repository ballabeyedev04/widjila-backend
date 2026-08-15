'use strict';

/**
 * Tests — config/security.js#validerMotDePasseAdmin (audit — Sécurité §3).
 *
 * Avant ce correctif, la seule protection était une comparaison EXACTE
 * contre deux mots de passe connus : n'importe quel troisième mauvais mot
 * de passe passait. Ces tests couvrent précisément ce cas — le point mort
 * de l'ancienne implémentation.
 */

const { validerMotDePasseAdmin } = require('../config/security.js');

describe('validerMotDePasseAdmin', () => {
  test('rejette les deux valeurs historiquement connues', () => {
    expect(validerMotDePasseAdmin('Admin1234!', 'a@b.com')).toBeTruthy();
    expect(validerMotDePasseAdmin('ChangeMe_MotDePasseForte123!', 'a@b.com')).toBeTruthy();
  });

  // Le point mort exact de l'ancienne implémentation : un TROISIÈME mauvais
  // mot de passe, ni dans la liste, ni robuste.
  test('rejette un troisième mauvais mot de passe absent de l\'ancienne liste noire', () => {
    expect(validerMotDePasseAdmin('Motdepasse2024!', 'a@b.com')).toBeTruthy();
  });

  test('rejette un mot de passe trop court même complexe', () => {
    expect(validerMotDePasseAdmin('Ab1!Ab1!', 'a@b.com')).toBeTruthy(); // 8 car., sous les 12 requis
  });

  test('rejette un mot de passe sans caractère spécial', () => {
    expect(validerMotDePasseAdmin('AbcdefGhij123', 'a@b.com')).toBeTruthy();
  });

  test('rejette un mot de passe sans majuscule', () => {
    expect(validerMotDePasseAdmin('abcdefghij123!', 'a@b.com')).toBeTruthy();
  });

  test('rejette un motif trop prévisible même long et complexe', () => {
    expect(validerMotDePasseAdmin('Qwerty123456!!', 'a@b.com')).toBeTruthy();
    expect(validerMotDePasseAdmin('Chantier2026!Prod', 'a@b.com')).toBeTruthy();
  });

  test('rejette un mot de passe contenant l\'email admin', () => {
    expect(validerMotDePasseAdmin('Superviseur2026!', 'superviseur@chantier.sn')).toBeTruthy();
  });

  test('accepte un mot de passe long, complexe, sans motif prévisible', () => {
    expect(validerMotDePasseAdmin('K7$mVq2!zRpL9xT', 'plateforme@chantier.sn')).toBeNull();
  });

  test('rejette une valeur vide ou absente', () => {
    expect(validerMotDePasseAdmin('', 'a@b.com')).toBeTruthy();
    expect(validerMotDePasseAdmin(undefined, 'a@b.com')).toBeTruthy();
  });
});
