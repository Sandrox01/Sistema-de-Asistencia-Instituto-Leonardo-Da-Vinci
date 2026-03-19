CREATE DATABASE IF NOT EXISTS asistencia_ldv
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE asistencia_ldv;

CREATE TABLE IF NOT EXISTS docentes (
  id_docente INT AUTO_INCREMENT PRIMARY KEY,
  dni VARCHAR(20) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  activacion TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_docentes_dni (dni)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cursos (
  id_curso INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  carrera ENUM('CAT', 'INSTITUTO', 'SECRETARIADO') NOT NULL DEFAULT 'CAT',
  turno ENUM('M', 'T', 'N', 'SIN') NOT NULL DEFAULT 'SIN',
  activacion TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS periodos (
  id_periodo INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  activacion TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_periodos_activo_fin (activacion, fecha_fin)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS horarios (
  id_horario INT AUTO_INCREMENT PRIMARY KEY,
  id_docente INT NOT NULL,
  id_curso INT NOT NULL,
  dia VARCHAR(16) NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fin TIME NOT NULL,
  id_periodo INT NULL,
  es_recuperacion TINYINT(1) NOT NULL DEFAULT 0,
  activacion TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_horarios_docente_dia (id_docente, dia, activacion, hora_inicio),
  KEY idx_horarios_curso (id_curso),
  KEY idx_horarios_periodo (id_periodo),
  CONSTRAINT fk_horarios_docente
    FOREIGN KEY (id_docente) REFERENCES docentes(id_docente),
  CONSTRAINT fk_horarios_curso
    FOREIGN KEY (id_curso) REFERENCES cursos(id_curso),
  CONSTRAINT fk_horarios_periodo
    FOREIGN KEY (id_periodo) REFERENCES periodos(id_periodo)
    ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS asistencias (
  id_asistencia INT AUTO_INCREMENT PRIMARY KEY,
  id_docente INT NOT NULL,
  id_curso INT NOT NULL,
  fecha DATE NOT NULL,
  hora_entrada TIME NULL,
  hora_salida TIME NULL,
  hora_entrada_prog TIME NOT NULL,
  hora_salida_prog TIME NOT NULL,
  minutos_observacion INT NULL,
  es_recuperacion TINYINT(1) NOT NULL DEFAULT 0,
  falta_recuperada TINYINT(1) NOT NULL DEFAULT 0,
  activacion TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_asistencias_docente_fecha (id_docente, fecha),
  KEY idx_asistencias_docente_curso_fecha (id_docente, id_curso, fecha),
  KEY idx_asistencias_activa (id_docente, fecha, hora_salida, hora_entrada),
  CONSTRAINT fk_asistencias_docente
    FOREIGN KEY (id_docente) REFERENCES docentes(id_docente),
  CONSTRAINT fk_asistencias_curso
    FOREIGN KEY (id_curso) REFERENCES cursos(id_curso)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bloqueados (
  id_bloqueo INT AUTO_INCREMENT PRIMARY KEY,
  dni VARCHAR(20) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  motivo VARCHAR(255) NULL,
  fecha_bloqueo DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_bloqueados_dni_tipo_activo (dni, tipo, activo)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS activaciones_especiales (
  id_activacion INT AUTO_INCREMENT PRIMARY KEY,
  dni VARCHAR(20) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  observaciones VARCHAR(255) NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_uso DATETIME NULL,
  KEY idx_activaciones_dni_tipo_usado (dni, tipo, usado),
  KEY idx_activaciones_fecha (fecha_creacion)
) ENGINE=InnoDB;
