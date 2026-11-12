// ==========================================================================
// KORTEXA — ADAPTADOR FORTUNESHEET (HOJA DE CÁLCULO ESTILO EXCEL)
// ==========================================================================

let reactLib = null;
let reactDomClient = null;
let fortuneSheetLib = null;
let isLoading = false;
let loadPromise = null;

// Carga perezosa (lazy load) de FortuneSheet y React para no penalizar el inicio de la app
export async function loadFortuneSheet() {
  if (fortuneSheetLib) {
    return { React: reactLib, ReactDOM: reactDomClient, FortuneSheet: fortuneSheetLib };
  }
  if (isLoading) {
    return loadPromise;
  }

  isLoading = true;
  loadPromise = (async () => {
    try {
      const [React, ReactDOM, FortuneSheet] = await Promise.all([
        import('https://esm.sh/react@18.2.0'),
        import('https://esm.sh/react-dom@18.2.0/client'),
        import('https://esm.sh/@fortune-sheet/react@1.0.4?deps=react@18.2.0,react-dom@18.2.0')
      ]);

      reactLib = React.default || React;
      reactDomClient = ReactDOM.default || ReactDOM;
      fortuneSheetLib = FortuneSheet;

      return { React: reactLib, ReactDOM: reactDomClient, FortuneSheet: fortuneSheetLib };
    } catch (err) {
      console.error('Error cargando FortuneSheet desde CDN:', err);
      throw err;
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}

// Convierte tablas 2D simples o JSON complejo a la estructura que espera FortuneSheet
export function convertToFortuneSheetData(rawData) {
  // 1. Si ya es una estructura válida de Sheet[]
  if (Array.isArray(rawData) && rawData.length > 0 && typeof rawData[0] === 'object' && !Array.isArray(rawData[0])) {
    return rawData.map((sheet, sIdx) => {
      const copy = { ...sheet };
      copy.status = copy.status !== undefined ? copy.status : (sIdx === 0 ? 1 : 0);
      copy.order = copy.order !== undefined ? copy.order : sIdx;
      copy.showGridLines = copy.showGridLines !== undefined ? copy.showGridLines : 1;

      // Si falta celldata pero tiene data (matriz 2D), construir celldata (requerido por FortuneSheet para renderizar celdas en el montaje)
      if ((!copy.celldata || !copy.celldata.length) && Array.isArray(copy.data)) {
        const cd = [];
        copy.data.forEach((row, r) => {
          if (Array.isArray(row)) {
            row.forEach((cell, c) => {
              if (cell !== null && cell !== undefined && cell !== '') {
                const cellObj = typeof cell === 'object' ? cell : { v: cell, m: String(cell) };
                cd.push({ r, c, v: cellObj });
              }
            });
          }
        });
        copy.celldata = cd;
      }
      return copy;
    });
  }

  // 2. Si es un array 2D: [["A", "B"], [1, 2]]
  const numRows = Array.isArray(rawData) ? rawData.length : 0;
  const numCols = Array.isArray(rawData?.[0]) ? rawData[0].length : 0;
  const rowCount = Math.max(20, numRows + 10);
  const colCount = Math.max(12, numCols + 6);

  // Crear matriz 2D limpia y celldata disperso para inicialización completa de FortuneSheet
  const data = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => null));
  const celldata = [];

  if (Array.isArray(rawData)) {
    rawData.forEach((row, r) => {
      if (Array.isArray(row)) {
        row.forEach((cellVal, c) => {
          if (r < rowCount && c < colCount) {
            if (cellVal !== null && cellVal !== undefined && cellVal !== '') {
              const strVal = String(cellVal).trim();
              let cellObj = null;

              // Fórmulas de Excel (empiezan con =)
              if (strVal.startsWith('=')) {
                cellObj = {
                  f: strVal,
                  v: null,
                  m: '',
                  bl: r === 0 ? 1 : 0
                };
              } else if (!isNaN(cellVal) && typeof cellVal === 'number') {
                cellObj = {
                  v: cellVal,
                  m: String(cellVal),
                  ct: { fa: 'General', t: 'n' },
                  bl: r === 0 ? 1 : 0
                };
              } else {
                cellObj = {
                  v: strVal,
                  m: strVal,
                  ct: { fa: 'General', t: 's' },
                  bl: r === 0 ? 1 : 0
                };
              }

              data[r][c] = cellObj;
              celldata.push({ r, c, v: cellObj });
            }
          }
        });
      }
    });
  }

  return [
    {
      name: 'Hoja 1',
      id: 'sheet_01',
      status: 1,
      order: 0,
      row: rowCount,
      column: colCount,
      showGridLines: 1,
      celldata,
      data
    }
  ];
}

// Convierte un Sheet[] de FortuneSheet a una matriz 2D limpia y compacta
export function fortuneSheetToClean2D(sheets) {
  if (!sheets || !sheets.length) return [[""]];
  const sheet = sheets[0];
  let matrix = [];

  if (Array.isArray(sheet.data) && sheet.data.length > 0) {
    matrix = sheet.data.map(row => {
      if (!Array.isArray(row)) return [];
      return row.map(cell => {
        if (!cell) return '';
        if (cell.f) return cell.f;
        if (cell.v !== undefined && cell.v !== null) return cell.v;
        if (cell.m !== undefined && cell.m !== null) return cell.m;
        return '';
      });
    });
  } else if (Array.isArray(sheet.celldata)) {
    let maxR = 0;
    let maxC = 0;
    sheet.celldata.forEach(item => {
      if (item.r > maxR) maxR = item.r;
      if (item.c > maxC) maxC = item.c;
    });
    for (let r = 0; r <= maxR; r++) {
      matrix.push(new Array(maxC + 1).fill(''));
    }
    sheet.celldata.forEach(item => {
      const cell = item.v;
      let val = '';
      if (cell) {
        val = cell.f || (cell.v !== undefined && cell.v !== null ? cell.v : (cell.m || ''));
      }
      if (matrix[item.r]) matrix[item.r][item.c] = val;
    });
  }

  // Recortar filas y columnas vacías residuales
  let lastNonEmptyRow = -1;
  let maxCol = -1;
  matrix.forEach((row, r) => {
    let hasContent = false;
    row.forEach((c, colIdx) => {
      if (c !== '' && c !== null && c !== undefined) {
        hasContent = true;
        if (colIdx > maxCol) maxCol = colIdx;
      }
    });
    if (hasContent) lastNonEmptyRow = r;
  });

  if (lastNonEmptyRow === -1) return [[""]];

  const trimmed = [];
  for (let r = 0; r <= lastNonEmptyRow; r++) {
    const row = matrix[r] || [];
    const newRow = [];
    for (let c = 0; c <= Math.max(0, maxCol); c++) {
      newRow.push(row[c] !== undefined ? row[c] : '');
    }
    trimmed.push(newRow);
  }
  return trimmed;
}

// Monta un libro de trabajo interactivo de FortuneSheet dentro de cualquier elemento DOM
export async function mountFortuneSheet(containerEl, initialData, options = {}) {
  const { React, ReactDOM, FortuneSheet } = await loadFortuneSheet();
  const Workbook = FortuneSheet.Workbook;

  const formattedData = convertToFortuneSheetData(initialData);

  // Limpiar cualquier contenido previo
  containerEl.innerHTML = '';
  const root = ReactDOM.createRoot(containerEl);
  const workbookRef = React.createRef ? React.createRef() : null;

  let latestData = formattedData;

  const props = {
    ref: workbookRef,
    data: formattedData,
    lang: 'es',
    showToolbar: options.showToolbar !== false,
    showGrid: true,
    showGridLines: true,
    showFormulaBar: options.showFormulaBar !== false,
    showSheetTabs: options.showSheetTabs !== false,
    onChange: (updatedData) => {
      latestData = updatedData;
      if (typeof options.onChange === 'function') {
        options.onChange(updatedData);
      }
    },
    onOp: (op) => {
      if (typeof options.onOp === 'function') {
        const currentData = (workbookRef && workbookRef.current && typeof workbookRef.current.getAllSheets === 'function')
          ? workbookRef.current.getAllSheets()
          : latestData;
        options.onOp(op, currentData);
      }
    }
  };

  root.render(React.createElement(Workbook, props));

  return {
    root,
    ref: workbookRef,
    getData: () => {
      if (workbookRef && workbookRef.current && typeof workbookRef.current.getAllSheets === 'function') {
        try {
          return workbookRef.current.getAllSheets();
        } catch (e) {}
      }
      return latestData;
    },
    unmount: () => {
      try {
        root.unmount();
      } catch (e) {
        // Ignorar si ya fue desmontado
      }
    }
  };
}

// Asignar al objeto global de window para acceso transparente desde app.js
if (typeof window !== 'undefined') {
  window.KortexaFortuneSheet = {
    loadFortuneSheet,
    convertToFortuneSheetData,
    fortuneSheetToClean2D,
    mountFortuneSheet
  };
}
