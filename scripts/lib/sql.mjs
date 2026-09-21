/** SQL 字面量的最小工具。只做转义，不做任何"聪明"的推断。 */

/**
 * 值 → SQL 字面量。
 *
 * 只认 string / number / boolean / null 四种，其余一律抛错而不是
 * JSON.stringify 糊过去——对象被悄悄写成 "[object Object]" 存在数据库里，
 * 是最难发现的一类数据损坏。
 */
export function lit(value) {
  if (value === null || value === undefined) return 'NULL';

  if (typeof value === 'boolean') return value ? '1' : '0';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`不能写入非有限数值：${value}`);
    }
    return String(value);
  }

  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      throw new Error('字符串里含 NUL 字节，SQLite 的 TEXT 存不住它');
    }
    // SQL 单引号字符串：内部的 ' 写成 ''
    return `'${value.replace(/'/g, "''")}'`;
  }

  throw new Error(`不支持的 SQL 值类型：${typeof value}`);
}

/** 列名列表 → "(a, b, c)" */
export function cols(names) {
  return `(${names.join(', ')})`;
}

/** 值列表 → "(1, 'a', NULL)" */
export function vals(values) {
  return `(${values.map(lit).join(', ')})`;
}
