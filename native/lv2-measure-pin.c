// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/*
 * lv2-measure-pin.c — the integrity block of an LV2 plugin; see lv2-measure-pin.h. Nothing here
 * hashes or serialises: plugin-hostd's pin.h does both, over the records lilv fills.
 */
#define _GNU_SOURCE
#include "lv2-measure-pin.h"

#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <plugin-hostd/pin.h>
#include <plugin-hostd/protocol.h>

#define MANIFEST "manifest.ttl"
#define PIN_FILES_MAX 64

struct pin_file {
  char *path;
  char sha256[PHD_SHA256_HEX_LEN + 1];
};

static void json_text(FILE *out, const char *s) {
  fputc('"', out);
  for (const char *p = s; *p; p++) {
    if (*p == '"' || *p == '\\') fprintf(out, "\\%c", *p);
    else if ((unsigned char)*p < 0x20) fprintf(out, "\\u%04x", *p);
    else fputc(*p, out);
  }
  fputc('"', out);
}

static void print_reason(FILE *out, const char *reason, const char *detail) {
  fprintf(out, "\"unmeasuredReason\":");
  json_text(out, reason);
  fprintf(out, ",\"unmeasuredDetail\":");
  json_text(out, detail);
}

/* the plugin's version as the interchange writes it: lv2:minorVersion.lv2:microVersion */
static char *plugin_version(LilvWorld *world, const LilvPlugin *plugin) {
  LilvNode *minor_p = lilv_new_uri(world, LV2_CORE__minorVersion);
  LilvNode *micro_p = lilv_new_uri(world, LV2_CORE__microVersion);
  /* through the plugin, so its data files are loaded first */
  LilvNodes *minor = lilv_plugin_get_value(plugin, minor_p);
  LilvNodes *micro = lilv_plugin_get_value(plugin, micro_p);
  const LilvNode *mi = minor ? lilv_nodes_get_first(minor) : NULL;
  const LilvNode *mc = micro ? lilv_nodes_get_first(micro) : NULL;
  char *version = NULL;
  if (mi && mc && lilv_node_is_int(mi) && lilv_node_is_int(mc) &&
      asprintf(&version, "%d.%d", lilv_node_as_int(mi), lilv_node_as_int(mc)) < 0)
    version = NULL;
  lilv_nodes_free(minor);
  lilv_nodes_free(micro);
  lilv_node_free(minor_p);
  lilv_node_free(micro_p);
  return version;
}

/* a file's path as the word of a pin: one word, a separator of pin_set or whitespace percent-encoded, as plugin-hostd reads it
 * (libSurge XT.so is libSurge%20XT.so); malloc'd */
static char *pin_word(const char *rel) {
  char *word = malloc(strlen(rel) * 3 + 1), *o = word;
  if (!word) return NULL;
  for (const char *c = rel; *c; c++)
    if (*c == '%' || strchr(PHD_PIN_PATH_EXCLUDED, *c)) o += sprintf(o, "%%%02X", (unsigned char)*c);
    else *o++ = *c;
  *o = '\0';
  return word;
}

/* a file of the bundle by its IRI: its path relative to the bundle root, the name on disk, or NULL with why */
static char *bundle_relative(const char *bundle, const LilvNode *iri, const char **why) {
  const char *text = lilv_node_as_uri(iri);
  char *path = lilv_file_uri_parse(text, NULL);
  if (!path) {
    *why = "a file the plugin loads is not a file: IRI";
    return NULL;
  }
  const size_t n = strlen(bundle);
  char *rel = NULL;
  if (strncmp(path, bundle, n) == 0 && path[n] != '\0') rel = strdup(path + n);
  lilv_free(path);
  if (!rel) *why = "a file the plugin loads lies outside its bundle";
  return rel;
}

static int add_file(struct pin_file *files, int *n, char *rel) {
  for (int i = 0; i < *n; i++)
    if (!strcmp(files[i].path, rel)) {
      free(rel);
      return 0;
    }
  if (*n == PIN_FILES_MAX) {
    free(rel);
    return -1;
  }
  files[(*n)++].path = rel;
  return 0;
}

/* whether the manifest sets a base, which plugin-hostd does not resolve */
static int manifest_based(const char *bundle) {
  char path[4096];
  snprintf(path, sizeof path, "%s%s", bundle, MANIFEST);
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  char line[4096];
  int based = 0;
  while (!based && fgets(line, sizeof line, f)) {
    const char *p = line + strspn(line, " \t");
    based = !strncmp(p, "@base", 5) || !strncasecmp(p, "BASE", 4);
  }
  fclose(f);
  return based;
}

static int by_path(const void *a, const void *b) {
  return strcmp(((const struct pin_file *)a)->path, ((const struct pin_file *)b)->path);
}

/* the omx-layout/1 fingerprint of the plugin's control ports; 0, or -1 */
static int layout_digest(LilvWorld *world, const LilvPlugin *plugin, char hex[PHD_SHA256_HEX_LEN + 1]) {
  const uint32_t n_ports = lilv_plugin_get_num_ports(plugin);
  LilvNode *control = lilv_new_uri(world, LV2_CORE__ControlPort);
  LilvNode *output = lilv_new_uri(world, LV2_CORE__OutputPort);
  phd_layout_lv2_port_t *ports = calloc(n_ports ? n_ports : 1, sizeof *ports);
  LilvNodes **props = calloc(n_ports ? n_ports : 1, sizeof *props);
  const char ***names = calloc(n_ports ? n_ports : 1, sizeof *names);
  size_t count = 0;
  int ret = -1;
  for (uint32_t i = 0; ports && props && names && i < n_ports; i++) {
    const LilvPort *port = lilv_plugin_get_port_by_index(plugin, i);
    if (!lilv_port_is_a(plugin, port, control)) continue;
    phd_layout_lv2_port_t *p = &ports[count];
    LilvNode *def = NULL, *min = NULL, *max = NULL;
    lilv_port_get_range(plugin, port, &def, &min, &max);
    p->index = lilv_port_get_index(plugin, port);
    p->symbol = lilv_node_as_string(lilv_port_get_symbol(plugin, port));
    p->output = lilv_port_is_a(plugin, port, output);
    if (min) p->has |= PHD_LAYOUT_HAS_MIN, p->min = lilv_node_as_float(min);
    if (max) p->has |= PHD_LAYOUT_HAS_MAX, p->max = lilv_node_as_float(max);
    if (def) p->has |= PHD_LAYOUT_HAS_DEF, p->def = lilv_node_as_float(def);
    lilv_node_free(def);
    lilv_node_free(min);
    lilv_node_free(max);
    props[count] = lilv_port_get_properties(plugin, port);
    const unsigned np = lilv_nodes_size(props[count]);
    names[count] = calloc(np ? np : 1, sizeof(char *));
    unsigned k = 0;
    LILV_FOREACH (nodes, it, props[count]) names[count][k++] = lilv_node_as_uri(lilv_nodes_get(props[count], it));
    p->properties = names[count];
    p->nproperties = k;
    count++;
  }
  if (ports && props && names) ret = phd_layout_lv2_digest(ports, count, hex);
  for (size_t i = 0; props && names && i < count; i++) {
    lilv_nodes_free(props[i]);
    free(names[i]);
  }
  free(names);
  free(props);
  free(ports);
  lilv_node_free(control);
  lilv_node_free(output);
  return ret;
}

void omx_lv2_pin_print(FILE *out, LilvWorld *world, const LilvPlugin *plugin) {
  char *version = plugin_version(world, plugin);
  if (version) {
    fprintf(out, ",\"version\":");
    json_text(out, version);
  }
  fprintf(out, ",\"integrity\":{");
  if (version) {
    fprintf(out, "\"version\":");
    json_text(out, version);
    fputc(',', out);
  }
  free(version);

  struct pin_file files[PIN_FILES_MAX];
  int n = 0;
  const char *why = NULL;
  char *bundle = lilv_file_uri_parse(lilv_node_as_uri(lilv_plugin_get_bundle_uri(plugin)), NULL);
  if (!bundle || bundle[0] == '\0' || bundle[strlen(bundle) - 1] != '/') why = "the bundle is not a directory";
  else if (manifest_based(bundle)) why = "the manifest sets @base, which plugin-hostd does not resolve";
  else {
    add_file(files, &n, strdup(MANIFEST));
    const LilvNode *library = lilv_plugin_get_library_uri(plugin);
    char *rel = library ? bundle_relative(bundle, library, &why) : NULL;
    if (!library) why = "the plugin names no lv2:binary";
    if (rel && add_file(files, &n, rel) != 0) why = "more files than a pin holds";
    const LilvNodes *data = lilv_plugin_get_data_uris(plugin);
    LILV_FOREACH (nodes, it, data) {
      if (why) break;
      const char *w = NULL;
      char *file = bundle_relative(bundle, lilv_nodes_get(data, it), &w);
      /* a file of another bundle is that bundle's: a worker's world is this one bundle */
      if (!file && w && !strstr(w, "outside")) why = w;
      if (file && add_file(files, &n, file) != 0) why = "more files than a pin holds";
    }
  }
  char layout[PHD_SHA256_HEX_LEN + 1];
  for (int i = 0; !why && i < n; i++) {
    char path[4096];
    snprintf(path, sizeof path, "%s%s", bundle, files[i].path);
    const int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0 || phd_pin_fd_digest(fd, files[i].sha256) != 0) why = "a file the plugin loads cannot be read";
    if (fd >= 0) close(fd);
  }
  if (!why && layout_digest(world, plugin, layout) != 0) why = "the layout could not be read";

  if (why) {
    print_reason(out, strstr(why, "cannot be read") || strstr(why, "could not") ? "probe-error" : "unpinnable", why);
  } else {
    qsort(files, (size_t)n, sizeof files[0], by_path);
    fprintf(out, "\"files\":[");
    for (int i = 0; i < n; i++) {
      fprintf(out, "%s{\"path\":", i ? "," : "");
      char *word = pin_word(files[i].path);
      json_text(out, word ? word : files[i].path);
      free(word);
      fprintf(out, ",\"sha256\":\"%s\"}", files[i].sha256);
    }
    fprintf(out, "],\"layout\":{\"scheme\":\"%s\",\"sha256\":\"%s\"}", PHD_PIN_LAYOUT_SCHEME, layout);
  }
  fputc('}', out);
  for (int i = 0; i < n; i++) free(files[i].path);
  lilv_free(bundle);
}
