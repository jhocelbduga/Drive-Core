"use strict";

(function (root) {
  function xml(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function csv(rows) {
    return "\ufeff" + rows.map(function (row) {
      return row.map(function (cell) {
        var value = String(cell === null || cell === undefined ? "" : cell);
        if (typeof cell !== "number" && /^[\s]*[=+\-@]/.test(value)) value = "'" + value;
        return '"' + value.replace(/"/g, '""') + '"';
      }).join(",");
    }).join("\r\n");
  }
  function column(index) {
    var label = "";
    for (index += 1; index > 0; index = Math.floor((index - 1) / 26)) label = String.fromCharCode(65 + (index - 1) % 26) + label;
    return label;
  }
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (var b = 0; b < 8; b += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    var encoder = new TextEncoder();
    var chunks = [];
    var directories = [];
    var offset = 0;
    function header(size) { return { bytes: new Uint8Array(size), view: null }; }
    files.forEach(function (file) {
      var name = encoder.encode(file[0]);
      var content = encoder.encode(file[1]);
      var crc = crc32(content);
      var local = header(30);
      local.view = new DataView(local.bytes.buffer);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, 20, true);
      local.view.setUint16(6, 0x0800, true);
      local.view.setUint32(14, crc, true);
      local.view.setUint32(18, content.length, true);
      local.view.setUint32(22, content.length, true);
      local.view.setUint16(26, name.length, true);
      chunks.push(local.bytes, name, content);
      var central = header(46);
      central.view = new DataView(central.bytes.buffer);
      central.view.setUint32(0, 0x02014b50, true);
      central.view.setUint16(4, 20, true);
      central.view.setUint16(6, 20, true);
      central.view.setUint16(8, 0x0800, true);
      central.view.setUint32(16, crc, true);
      central.view.setUint32(20, content.length, true);
      central.view.setUint32(24, content.length, true);
      central.view.setUint16(28, name.length, true);
      central.view.setUint32(42, offset, true);
      directories.push(central.bytes, name);
      offset += local.bytes.length + name.length + content.length;
    });
    var directoryLength = directories.reduce(function (total, bytes) { return total + bytes.length; }, 0);
    var end = header(22);
    end.view = new DataView(end.bytes.buffer);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, files.length, true);
    end.view.setUint16(10, files.length, true);
    end.view.setUint32(12, directoryLength, true);
    end.view.setUint32(16, offset, true);
    var all = chunks.concat(directories, [end.bytes]);
    var result = new Uint8Array(offset + directoryLength + end.bytes.length);
    var position = 0;
    all.forEach(function (bytes) { result.set(bytes, position); position += bytes.length; });
    return result;
  }
  function xlsx(rows) {
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach(function (row, index) {
      sheet += '<row r="' + (index + 1) + '">';
      row.forEach(function (cell, col) {
        var address = column(col) + (index + 1);
        sheet += typeof cell === "number" && Number.isFinite(cell)
          ? '<c r="' + address + '"><v>' + cell + '</v></c>'
          : '<c r="' + address + '" t="inlineStr"><is><t xml:space="preserve">' + xml(cell === null || cell === undefined ? "" : cell) + '</t></is></c>';
      });
      sheet += "</row>";
    });
    sheet += "</sheetData></worksheet>";
    return zip([
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="DriveCore Report" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ["xl/worksheets/sheet1.xml", sheet]
    ]);
  }
  var api = { csv: csv, xlsx: xlsx };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DriveCoreExports = api;
})(typeof window !== "undefined" ? window : globalThis);
