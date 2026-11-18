#!/usr/bin/env python3
"""Génère les fichiers d'import CSV/XLSX synthétiques de vérification.

## Pourquoi un générateur et non des fichiers figés

Les fichiers de test doivent rester **reproductibles** et **relisibles** : un
binaire XLSX ne se relit pas en revue de code. Ce script régénère les mêmes
octets, et le CSV est écrit lisible tel quel.

## Contenu volontaire

Les fichiers couvrent délibérément les cas limites du cahier des charges :
noms/descriptions/prix/devises/stocks, catégories et images, variantes (XLSX),
doublons internes, lignes invalides, champs facultatifs manquants, et pièges
d'injection de formule (cellules commençant par `=`, `+`, `-`, `@`).

## Données strictement fictives

Aucune marque, aucun produit, aucun prix réels. Le domaine `exemple.invalid`
est réservé (RFC 2606) et ne résout jamais.

## Usage

    python3 supabase/tests/import-fichiers/generer.py

Sortie : `produits.csv`, `produits.xlsx`, `variantes.xlsx`, dans ce dossier.
"""
from pathlib import Path

from openpyxl import Workbook

ICI = Path(__file__).parent

# --------------------------------------------------------------------------
# CSV — cas nominal + pièges
# --------------------------------------------------------------------------
# Colonnes attendues par l'analyseur (synonymes acceptés, cf. files.ts).
ENTETE = ["name", "description", "price", "currency", "stock", "category", "image", "sku"]

LIGNES_CSV = [
    # 1. Produit complet, prix décimal en XOF.
    ["Sac en toile Koulikoro", "Sac artisanal en coton épais, bandoulière réglable.", "18500", "XOF", "12",
     "Sacs", "https://exemple.invalid/images/sac-koulikoro.jpg", "SAC-001"],
    # 2. Prix européen avec virgule décimale et espace insécable — piège classique.
    ["Théière Bamako", "Théière en fonte émaillée, 1,2 L.", "24,90", "EUR", "5",
     "Cuisine", "https://exemple.invalid/images/theiere.jpg", "THE-002"],
    # 3. Prix formaté avec séparateur de milliers et symbole.
    ["Tableau d'art Dogon", "Reproduction encadrée, 40 × 60 cm.", "45 000 FCFA", "XOF", "3",
     "Décoration", "https://exemple.invalid/images/tableau.jpg", "ART-003"],
    # 4. Cellule commençant par « = » : injection de formule, à neutraliser.
    ["=HYPERLINK(\"http://exemple.invalid/phish\")", "Tentative d'injection de formule.", "1000", "XOF", "1",
     "Divers", "", "INJ-004"],
    # 5. Champ facultatif description manquant.
    ["Bouilloire Sahel", "", "15000", "XOF", "8", "Cuisine", "https://exemple.invalid/images/bouilloire.jpg", "CUI-005"],
    # 6. Doublon exact du produit 1 (nom identique, casse différente).
    ["sac en toile koulikoro", "Doublon volontaire du premier produit.", "18500", "XOF", "12",
     "Sacs", "https://exemple.invalid/images/sac-koulikoro.jpg", "SAC-001"],
    # 7. Prix absent : doit être importable mais signalé « prix à compléter ».
    ["Panier tressé Ségou", "Panier en osier tressé main.", "", "XOF", "20", "Maison", "", "PAN-007"],
    # 8. Ligne invalide : nom vide — doit être rejetée, pas inventée.
    ["", "Produit sans nom.", "5000", "XOF", "2", "Divers", "", "INV-008"],
    # 9. Prix non numérique — doit produire un avertissement, pas un prix faux.
    ["Marmite en fonte", "Marmite traditionnelle, 5 L.", "prix sur demande", "XOF", "4", "Cuisine", "", "MAR-009"],
    # 10. Devise inconnue : à refuser ou ramener à la devise par défaut, sans invention.
    ["Statuette Dogon", "Sculpture en bois, pièce unique.", "12000", "XYZ", "1", "Art", "", "STA-010"],
    # 11. Très longue description : la troncature doit rester propre.
    ["Tapis de prière", "Tissé main. " * 400, "25000", "XOF", "2", "Maison", "", "TAP-011"],
    # 12. Caractères à échapper en CSV : guillemets et virgules internes.
    ["Bol \"spécial\" Dakar", "Contient des guillemets \"doubles\" et, une virgule.", "3500", "XOF", "30",
     "Cuisine", "", "BOL-012"],
    # 13. Stock négatif : anomalie de données à signaler.
    ["Coussin brodé", "Coussin décoratif 45 × 45 cm.", "9500", "XOF", "-3", "Maison", "", "COU-013"],
    # 14. URL d'image en http (non sûre) — l'interface doit la refuser ou la signaler.
    ["Lampe en cuivre", "Lampe de table artisanale.", "32000", "XOF", "6", "Décoration",
     "http://exemple.invalid/images/lampe.jpg", "LAM-014"],
]


def echapper(cellule: str) -> str:
    """Échappement RFC 4180 : guillemets doublés, cellule citée si nécessaire."""
    if any(c in cellule for c in [",", '"', "\n", "\r"]):
        return '"' + cellule.replace('"', '""') + '"'
    return cellule


def ecrire_csv() -> Path:
    chemin = ICI / "produits.csv"
    with chemin.open("w", encoding="utf-8", newline="\n") as f:
        f.write(",".join(ENTETE) + "\n")
        for ligne in LIGNES_CSV:
            f.write(",".join(echapper(c) for c in ligne) + "\n")
    return chemin


# --------------------------------------------------------------------------
# XLSX 1 — produits avec catégories et images (mêmes données que le CSV)
# --------------------------------------------------------------------------
def ecrire_xlsx_produits() -> Path:
    classeur = Workbook()
    feuille = classeur.active
    feuille.title = "Produits"
    feuille.append(ENTETE)
    for ligne in LIGNES_CSV:
        feuille.append(ligne)
    chemin = ICI / "produits.xlsx"
    classeur.save(chemin)
    return chemin


# --------------------------------------------------------------------------
# XLSX 2 — produits avec VARIANTES (une ligne par variante)
# --------------------------------------------------------------------------
# Le parseur ne connaît pas encore la notion de variante : son comportement
# actuel est de traiter chaque ligne comme un produit distinct. Ce fichier sert
# précisément à mesurer cette limite (trois lignes → trois produits au lieu
# d'un produit à trois variantes). Le documenter vaut mieux que le supposer.
ENTETE_VARIANTES = [
    "name", "description", "price", "currency", "stock",
    "category", "image", "sku", "variant_name", "variant_option", "parent_sku",
]

LIGNES_VARIANTES = [
    ["T-shirt Bogolan", "T-shirt coton bio, motif bogolan.", "12000", "XOF", "10",
     "Vêtements", "https://exemple.invalid/images/tshirt.jpg", "TSH-S", "Taille", "S", "TSH"],
    ["T-shirt Bogolan", "T-shirt coton bio, motif bogolan.", "12000", "XOF", "15",
     "Vêtements", "https://exemple.invalid/images/tshirt.jpg", "TSH-M", "Taille", "M", "TSH"],
    ["T-shirt Bogolan", "T-shirt coton bio, motif bogolan.", "12500", "XOF", "7",
     "Vêtements", "https://exemple.invalid/images/tshirt.jpg", "TSH-L", "Taille", "L", "TSH"],
    ["Sandales cuir Gao", "Sandales en cuir tanné, semelle cousue.", "28000", "XOF", "4",
     "Chaussures", "https://exemple.invalid/images/sandales.jpg", "SAN-41", "Pointure", "41", "SAN"],
    ["Sandales cuir Gao", "Sandales en cuir tanné, semelle cousue.", "28000", "XOF", "2",
     "Chaussures", "https://exemple.invalid/images/sandales.jpg", "SAN-43", "Pointure", "43", "SAN"],
    # Variante sans prix : doit rester signalée, pas inventée.
    ["Sandales cuir Gao", "Sandales en cuir tanné, semelle cousue.", "", "XOF", "0",
     "Chaussures", "https://exemple.invalid/images/sandales.jpg", "SAN-45", "Pointure", "45", "SAN"],
]


def ecrire_xlsx_variantes() -> Path:
    classeur = Workbook()
    feuille = classeur.active
    feuille.title = "Variantes"
    feuille.append(ENTETE_VARIANTES)
    for ligne in LIGNES_VARIANTES:
        feuille.append(ligne)
    chemin = ICI / "variantes.xlsx"
    classeur.save(chemin)
    return chemin


if __name__ == "__main__":
    for fonction in (ecrire_csv, ecrire_xlsx_produits, ecrire_xlsx_variantes):
        chemin = fonction()
        print(f"{chemin.name:20s} {chemin.stat().st_size:>8d} octets")
