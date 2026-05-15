const pool = require('../database');
const fs = require('fs');
const path = require('path');

const SEED_DATA = [
    { cod: '10001', nom: 'CENTRO ESCOLAR CATÓLICO "SAN JOSÉ"', dep: 'SAN SALVADOR', mun: 'SAN SALVADOR' },
    { cod: '10002', nom: 'CENTRO ESCOLAR "GENERAL FRANCISCO MENÉNDEZ"', dep: 'SAN SALVADOR', mun: 'SAN SALVADOR' },
    { cod: '10003', nom: 'COLEGIO CRISTIANO "EL SHADDAI"', dep: 'SAN SALVADOR', mun: 'SAN SALVADOR' },
    { cod: '10004', nom: 'COLEGIO BILINGÜE "MAQUILISHUAT"', dep: 'SAN SALVADOR', mun: 'SAN SALVADOR' },
    { cod: '10005', nom: 'ESCUELA AMERICANA', dep: 'SAN SALVADOR', mun: 'SAN SALVADOR' },
    { cod: '10006', nom: 'COLEGIO EXSAL', dep: 'SAN SALVADOR', mun: 'SAN SALVADOR' },
    { cod: '11001', nom: 'CENTRO ESCOLAR "DR. JOSÉ MATÍAS DELGADO"', dep: 'LA LIBERTAD', mun: 'SANTA TECLA' },
    { cod: '11002', nom: 'COLEGIO SANTA CECILIA', dep: 'LA LIBERTAD', mun: 'SANTA TECLA' },
    { cod: '12001', nom: 'CENTRO ESCOLAR "NICOLÁS AGUILAR"', dep: 'SAN VICENTE', mun: 'SAN VICENTE' },
    { cod: '13001', nom: 'CENTRO ESCOLAR "INSA"', dep: 'SANTA ANA', mun: 'SANTA ANA' },
    { cod: '14001', nom: 'CENTRO ESCOLAR "MODESTO BARRIOS"', dep: 'SONSONATE', mun: 'SONSONATE' }
];

async function seedSedes() {
    console.log('🚀 Iniciando carga de Sedes Educativas...');
    
    try {
        for (const sede of SEED_DATA) {
            await pool.query(
                `INSERT INTO sedes_educativas (codigo_infraestructura, nombre_oficial, departamento, municipio)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (codigo_infraestructura) DO UPDATE 
                 SET nombre_oficial = EXCLUDED.nombre_oficial`,
                [sede.cod, sede.nom, sede.dep, sede.mun]
            );
        }
        console.log('✅ Catálogo inicial de sedes cargado con éxito.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error cargando sedes:', error.message);
        process.exit(1);
    }
}

seedSedes();
